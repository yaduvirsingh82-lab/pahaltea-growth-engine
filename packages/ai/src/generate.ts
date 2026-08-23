import { withTransaction, type PoolLike } from "../../db/src/client.ts";
import { completeGenerationRun, persistConcept, startGenerationRun, type PersistedDraft } from "./persist.ts";
import { PROMPT_TEMPLATE_NAME, PROMPT_TEMPLATE_VERSION, buildSystemPrompt, buildUserPrompt, requestHash, type PromptOptions } from "./prompt.ts";
import type { GenerationProvider } from "./provider.ts";
import { persistSnapshot, retrieveApprovedClaims } from "./retrieval.ts";
import { conceptBatchJsonSchema, parseConceptBatch } from "./schema.ts";
import { validateConcept } from "./validate.ts";

export interface GenerateOptions extends PromptOptions {
  organisationId: string;
  createdBy: string;
  provider: GenerationProvider;
  environment: string;
  maxOutputTokens?: number;
}

export interface GenerateOutcome {
  runId: string;
  provider: string;
  model: string;
  isOfflineStub: boolean;
  claimsRetrieved: number;
  retrievalSnapshotHash: string;
  drafts: PersistedDraft[];
  rejected: number;
}

/**
 * Retrieve approved claims, generate, validate, persist — in that order, with
 * the run recorded before the provider is called so a crashed or hanging
 * generation still leaves a trace.
 *
 * Nothing here can publish. The most a draft can reach is `claim_validation`,
 * awaiting human review.
 */
export async function generateInstagramConcepts(
  pool: PoolLike,
  options: GenerateOptions,
): Promise<GenerateOutcome> {
  if (options.provider.isOfflineStub && options.environment === "production") {
    throw new Error("The offline generator cannot run in production; its output is placeholder copy.");
  }

  const snapshot = await retrieveApprovedClaims(pool, options.organisationId);
  if (snapshot.claims.length === 0) {
    throw new Error(
      "No approved claims are available for this organisation. Run `npm run db:seed` first, or resolve the outstanding claim approvals.",
    );
  }

  const system = buildSystemPrompt();
  const prompt = buildUserPrompt(snapshot.claims, options);

  const runId = await withTransaction(pool, async (tx) => {
    await persistSnapshot(tx, options.organisationId, snapshot);
    return startGenerationRun(tx, {
      organisationId: options.organisationId,
      provider: options.provider.id,
      model: options.provider.model,
      isOfflineStub: options.provider.isOfflineStub,
      promptTemplateName: PROMPT_TEMPLATE_NAME,
      promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
      retrievalSnapshotHash: snapshot.hash,
      requestHash: requestHash(system, prompt, options.provider.model),
      startedAt: new Date(),
    });
  });

  try {
    const result = await options.provider.generate({
      system,
      prompt,
      jsonSchema: conceptBatchJsonSchema,
      schemaName: "instagram_concepts",
      maxOutputTokens: options.maxOutputTokens ?? 16_000,
    });

    const { batch, violations } = parseConceptBatch(result.parsed);
    if (!batch) {
      throw new Error(
        `Provider output did not match the concept schema:\n${violations
          .map((violation) => `  ${violation.path}: ${violation.message}`)
          .join("\n")}`,
      );
    }

    const drafts = await withTransaction(pool, async (tx) => {
      const persisted: PersistedDraft[] = [];
      for (const concept of batch.concepts) {
        persisted.push(
          await persistConcept(tx, {
            organisationId: options.organisationId,
            generationRunId: runId,
            createdBy: options.createdBy,
            concept,
            validation: validateConcept(concept, snapshot.claims),
          }),
        );
      }
      await completeGenerationRun(tx, runId, { status: "succeeded", usage: result.usage });
      return persisted;
    });

    return {
      runId,
      provider: result.provider,
      model: result.model,
      isOfflineStub: options.provider.isOfflineStub,
      claimsRetrieved: snapshot.claims.length,
      retrievalSnapshotHash: snapshot.hash,
      drafts,
      rejected: drafts.filter((draft) => !draft.valid).length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await completeGenerationRun(pool, runId, { status: "failed", error: message }).catch(() => undefined);
    throw error;
  }
}
