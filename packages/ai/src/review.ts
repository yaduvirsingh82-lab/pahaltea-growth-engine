import { randomUUID } from "node:crypto";
import { withTransaction, type PoolLike, type Queryable } from "../../db/src/client.ts";
import { PostgresAuditRepository } from "../../db/src/repositories/audit.ts";
import { applyContentReview, type ContentDraft } from "../../domain/src/content.ts";
import { canExecute } from "../../domain/src/policy.ts";
import type { ActionRequest, Environment, Role } from "../../domain/src/types.ts";

export interface DraftSummary {
  id: string;
  conceptName: string;
  format: string;
  objective: string;
  status: string;
  hook: string;
  createdBy: string;
  createdAt: Date;
  isOfflineStub: boolean;
  provider: string;
  failedChecks: string[];
}

export interface DraftDetail extends DraftSummary {
  caption: string;
  visualBrief: string;
  cta: string;
  trialOffer: string;
  socialProofAngle: string;
  hashtags: string[];
  rationale: string;
  citedClaims: { id: string; wording: string }[];
  checks: { name: string; passed: boolean; detail: string }[];
  reviewedBy?: string;
  reviewNote?: string;
}

export async function listDrafts(
  executor: Queryable,
  organisationId: string,
  filter: { status?: string } = {},
): Promise<DraftSummary[]> {
  const result = await executor.query(
    `SELECT d.id, d.concept_name, d.format, d.objective, d.status, d.hook, d.created_by, d.created_at,
            COALESCE(r.is_offline_stub, false) AS is_offline_stub,
            COALESCE(r.provider, 'unknown') AS provider,
            COALESCE(
              array_agg(v.check_name ORDER BY v.check_name) FILTER (WHERE v.passed = false),
              ARRAY[]::text[]
            ) AS failed_checks
       FROM content_drafts d
       LEFT JOIN generation_runs r ON r.id = d.generation_run_id
       LEFT JOIN content_validation_results v ON v.content_draft_id = d.id
      WHERE d.organisation_id = $1
        AND ($2::text IS NULL OR d.status = $2)
      GROUP BY d.id, r.is_offline_stub, r.provider
      ORDER BY d.created_at DESC`,
    [organisationId, filter.status ?? null],
  );
  return result.rows.map(toSummary);
}

export async function getDraft(executor: Queryable, draftId: string): Promise<DraftDetail | undefined> {
  const result = await executor.query(
    `SELECT d.*, COALESCE(r.is_offline_stub, false) AS is_offline_stub, COALESCE(r.provider, 'unknown') AS provider
       FROM content_drafts d
       LEFT JOIN generation_runs r ON r.id = d.generation_run_id
      WHERE d.id = $1`,
    [draftId],
  );
  const row = result.rows[0];
  if (!row) return undefined;

  const checks = await executor.query(
    `SELECT check_name, passed, detail FROM content_validation_results
      WHERE content_draft_id = $1 ORDER BY check_name`,
    [draftId],
  );
  const claims = await executor.query(
    `SELECT c.id, c.wording FROM content_claim_citations cc
       JOIN claims c ON c.id = cc.claim_id
      WHERE cc.content_draft_id = $1 ORDER BY c.wording`,
    [draftId],
  );

  return {
    ...toSummary({
      ...row,
      failed_checks: checks.rows.filter((check) => check.passed === false).map((check) => check.check_name),
    }),
    caption: String(row.caption ?? ""),
    visualBrief: String(row.visual_brief ?? ""),
    cta: String(row.cta ?? ""),
    trialOffer: String(row.trial_offer ?? ""),
    socialProofAngle: String(row.social_proof_angle ?? ""),
    hashtags: (row.hashtags as string[]) ?? [],
    rationale: String(row.rationale ?? ""),
    citedClaims: claims.rows.map((claim) => ({ id: String(claim.id), wording: String(claim.wording) })),
    checks: checks.rows.map((check) => ({
      name: String(check.check_name),
      passed: Boolean(check.passed),
      detail: String(check.detail),
    })),
    reviewedBy: row.reviewed_by ? String(row.reviewed_by) : undefined,
    reviewNote: row.review_note ? String(row.review_note) : undefined,
  };
}

export interface ReviewInput {
  draftId: string;
  reviewerId: string;
  reviewerRoles: readonly Role[];
  decision: "approved" | "rejected";
  note?: string;
  environment: Environment;
}

export interface ReviewResult {
  applied: boolean;
  status: string;
  reason: string;
}

/**
 * Records a review decision through the existing approval machinery rather than
 * flipping a status column. An approval creates an `approval_requests` row for
 * the `content.publish` action and an `approval_decisions` row bound to the
 * draft's payload hash, then re-checks `canExecute` before the draft moves.
 *
 * Approving a draft does not publish it. It records that a human released this
 * exact payload; publishing remains blocked by policy and unimplemented.
 */
export async function reviewDraft(pool: PoolLike, input: ReviewInput): Promise<ReviewResult> {
  return withTransaction(pool, async (tx) => {
    const loaded = await tx.query(
      `SELECT id, organisation_id, status, created_by, channel, caption
         FROM content_drafts WHERE id = $1 FOR UPDATE`,
      [input.draftId],
    );
    const row = loaded.rows[0];
    if (!row) return { applied: false, status: "unknown", reason: `No draft with id ${input.draftId}.` };

    const failing = await tx.query(
      `SELECT check_name FROM content_validation_results WHERE content_draft_id = $1 AND passed = false`,
      [input.draftId],
    );
    if (input.decision === "approved" && (failing.rowCount ?? 0) > 0) {
      return {
        applied: false,
        status: String(row.status),
        reason: `Cannot approve a draft with failing checks: ${failing.rows
          .map((check) => check.check_name)
          .join(", ")}.`,
      };
    }

    const draft: ContentDraft = {
      id: String(row.id),
      organisationId: String(row.organisation_id),
      channel: "instagram",
      body: String(row.caption ?? ""),
      citedClaimIds: [],
      status: row.status as ContentDraft["status"],
      createdBy: String(row.created_by),
    };

    let nextStatus: string;
    try {
      nextStatus = applyContentReview(draft, {
        draftId: draft.id,
        reviewerId: input.reviewerId,
        reviewerRoles: input.reviewerRoles,
        decision: input.decision,
        note: input.note,
        decidedAt: new Date(),
      }).status;
    } catch (error) {
      return { applied: false, status: draft.status, reason: error instanceof Error ? error.message : String(error) };
    }

    const payloadHash = await draftPayloadHash(tx, input.draftId);

    if (input.decision === "approved") {
      const approvalRequestId = randomUUID();
      await tx.query(
        `INSERT INTO approval_requests (id, organisation_id, action_kind, environment, actor_id, payload_hash, risk_level, status, expires_at)
         VALUES ($1, $2, 'content.publish', $3, $4, $5, 'medium', 'approved', now() + interval '30 days')`,
        [approvalRequestId, draft.organisationId, input.environment, draft.createdBy, payloadHash],
      );
      await tx.query(
        `INSERT INTO approval_decisions (approval_request_id, approver_id, payload_hash, decision)
         VALUES ($1, $2, $3, 'approved')`,
        [approvalRequestId, input.reviewerId, payloadHash],
      );

      // Re-check through the real policy engine, not a local shortcut.
      const request: ActionRequest = {
        id: approvalRequestId,
        organisationId: draft.organisationId,
        kind: "content.publish",
        environment: input.environment,
        actorId: draft.createdBy,
        payloadHash,
        risk: "medium",
      };
      const verdict = canExecute(request, [
        {
          requestId: approvalRequestId,
          approverId: input.reviewerId,
          approverRoles: input.reviewerRoles,
          payloadHash,
          decision: "approved",
          decidedAt: new Date(),
        },
      ]);
      if (!verdict.allowed) {
        throw new Error(`Approval policy refused the release: ${verdict.reason}`);
      }
    }

    await tx.query(
      `UPDATE content_drafts
          SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4
        WHERE id = $1`,
      [input.draftId, nextStatus, input.reviewerId, input.note ?? null],
    );

    await new PostgresAuditRepository(tx).append({
      organisationId: draft.organisationId,
      actorId: input.reviewerId,
      action: input.decision === "approved" ? "content.review_approved" : "content.review_rejected",
      entityType: "content_draft",
      entityId: draft.id,
      payloadHash,
      correlationId: randomUUID(),
      occurredAt: new Date(),
    });

    return { applied: true, status: nextStatus, reason: `Draft ${input.decision} by ${input.reviewerId}.` };
  });
}

/** Binds an approval to the exact copy that was reviewed. */
async function draftPayloadHash(executor: Queryable, draftId: string): Promise<string> {
  const result = await executor.query(
    `SELECT encode(sha256(convert_to(
              coalesce(concept_name,'') || E'\n' || coalesce(hook,'') || E'\n' || coalesce(caption,'') || E'\n' ||
              coalesce(cta,'') || E'\n' || coalesce(trial_offer,'') || E'\n' || coalesce(social_proof_angle,''),
              'UTF8')), 'hex') AS hash
       FROM content_drafts WHERE id = $1`,
    [draftId],
  );
  return String(result.rows[0].hash);
}

function toSummary(row: Record<string, unknown>): DraftSummary {
  return {
    id: String(row.id),
    conceptName: String(row.concept_name ?? ""),
    format: String(row.format ?? ""),
    objective: String(row.objective ?? ""),
    status: String(row.status),
    hook: String(row.hook ?? ""),
    createdBy: String(row.created_by),
    createdAt: new Date(row.created_at as string),
    isOfflineStub: Boolean(row.is_offline_stub),
    provider: String(row.provider ?? "unknown"),
    failedChecks: (row.failed_checks as string[]) ?? [],
  };
}
