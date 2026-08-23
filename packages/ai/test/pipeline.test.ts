import assert from "node:assert/strict";
import test from "node:test";
import { OfflineTemplateProvider } from "../src/providers/offline.ts";
import { createProvider, providerIds, resolveProvider } from "../src/providers/index.ts";
import { parseJsonObject } from "../src/provider.ts";
import { buildSystemPrompt, buildUserPrompt } from "../src/prompt.ts";
import type { ApprovedClaimRecord } from "../src/retrieval.ts";
import { snapshotHash } from "../src/retrieval.ts";
import { CAPTION_MAX_LENGTH, HOOK_MAX_LENGTH, conceptBatchJsonSchema, parseConceptBatch } from "../src/schema.ts";
import { validateConcept } from "../src/validate.ts";

const claims: ApprovedClaimRecord[] = [
  { id: "11111111-1111-5111-8111-111111111111", productId: "p", productName: "Masala Tea", wording: "Origin/garden: Assam", version: 1, evidenceReferences: ["AGENTS.md"] },
  { id: "22222222-2222-5222-8222-222222222222", productId: "p", productName: "Masala Tea", wording: "Ingredients: Tea & Spices", version: 1, evidenceReferences: ["packet"] },
  { id: "33333333-3333-5333-8333-333333333333", productId: "p", productName: "Masala Tea", wording: "No added flavours, colours, preservatives, or additives", version: 1, evidenceReferences: ["packet"] },
];

test("the system prompt contains no product facts of its own", () => {
  const system = buildSystemPrompt();
  // Facts belong in retrieved claims, never in the prompt template.
  for (const leak of ["Assam", "Amchong", "200g", "Tea & Spices"]) {
    assert.equal(system.includes(leak), false, `System prompt leaks the fact "${leak}".`);
  }
  assert.match(system, /citedClaimIds/);
});

test("the user prompt carries every approved claim with its id", () => {
  const prompt = buildUserPrompt(claims, { count: 3 });
  for (const claim of claims) {
    assert.ok(prompt.includes(claim.id), `Prompt is missing claim ${claim.id}.`);
    assert.ok(prompt.includes(claim.wording));
  }
  assert.match(prompt, /Produce exactly 3 distinct concepts/);
});

test("snapshot hash changes when a claim version or wording changes", () => {
  const base = snapshotHash(claims);
  assert.equal(base, snapshotHash([...claims].reverse()), "Hash must not depend on ordering.");
  assert.notEqual(base, snapshotHash([...claims.slice(1)]));
  assert.notEqual(base, snapshotHash([{ ...claims[0], version: 2 }, ...claims.slice(1)]));
});

test("the offline provider produces schema-valid concepts that pass every check", async () => {
  const provider = new OfflineTemplateProvider();
  assert.equal(provider.isOfflineStub, true, "The offline provider must declare itself a stub.");

  const result = await provider.generate({
    system: buildSystemPrompt(),
    prompt: buildUserPrompt(claims, { count: 5 }),
    jsonSchema: conceptBatchJsonSchema,
    schemaName: "instagram_concepts",
    maxOutputTokens: 4000,
  });

  const { batch, violations } = parseConceptBatch(result.parsed);
  assert.deepEqual(violations, []);
  assert.equal(batch?.concepts.length, 5);

  for (const concept of batch!.concepts) {
    const validation = validateConcept(concept, claims);
    assert.equal(
      validation.valid,
      true,
      `Offline concept "${concept.conceptName}" failed: ${JSON.stringify(validation.checks.filter((c) => !c.passed))}`,
    );
    assert.ok(concept.hook.length <= HOOK_MAX_LENGTH);
    assert.ok(concept.caption.length <= CAPTION_MAX_LENGTH);
  }
});

test("the offline provider is deterministic for the same prompt", async () => {
  const provider = new OfflineTemplateProvider();
  const request = {
    system: buildSystemPrompt(),
    prompt: buildUserPrompt(claims, { count: 3 }),
    jsonSchema: conceptBatchJsonSchema,
    schemaName: "instagram_concepts",
    maxOutputTokens: 4000,
  };
  const first = await provider.generate(request);
  const second = await provider.generate(request);
  assert.equal(first.raw, second.raw);
});

test("the offline provider refuses a prompt with no approved claims", async () => {
  await assert.rejects(
    () =>
      new OfflineTemplateProvider().generate({
        system: "",
        prompt: "no claims here",
        jsonSchema: conceptBatchJsonSchema,
        schemaName: "instagram_concepts",
        maxOutputTokens: 100,
      }),
    /no approved claim IDs/,
  );
});

test("validation rejects a concept citing an unapproved claim", () => {
  const validation = validateConcept(
    {
      conceptName: "bad citation",
      format: "feed_post",
      objective: "trial",
      hook: "A hook",
      caption: "A caption",
      visualBrief: "A brief",
      cta: "Buy now",
      trialOffer: "One pack",
      socialProofAngle: "Invite first buyers",
      hashtags: [],
      citedClaimIds: ["99999999-9999-5999-8999-999999999999"],
      rationale: "why",
    },
    claims,
  );
  assert.equal(validation.valid, false);
  const check = validation.checks.find((entry) => entry.name === "claim_citation");
  assert.equal(check?.passed, false);
  assert.match(check!.detail, /not approved with evidence/);
});

test("validation rejects prohibited language even when citations are valid", () => {
  const validation = validateConcept(
    {
      conceptName: "health claim",
      format: "reel",
      objective: "trial",
      hook: "Boost your immunity every morning",
      caption: "Tea and spices from Assam that aid digestion.",
      visualBrief: "A cup",
      cta: "Buy now",
      trialOffer: "One pack",
      socialProofAngle: "Invite first buyers",
      hashtags: [],
      citedClaimIds: [claims[0].id],
      rationale: "why",
    },
    claims,
  );
  assert.equal(validation.valid, false);
  assert.equal(validation.checks.find((entry) => entry.name === "prohibited_terms")?.passed, false);
  assert.ok(validation.prohibited.some((match) => match.category === "health_or_wellness"));
});

test("validation rejects an over-length caption and a missing trial lever", () => {
  const base = {
    conceptName: "long",
    format: "story" as const,
    objective: "trial" as const,
    hook: "Hook",
    visualBrief: "A cup",
    socialProofAngle: "Invite first buyers",
    hashtags: [],
    citedClaimIds: [claims[0].id],
    rationale: "why",
  };
  const tooLong = validateConcept({ ...base, caption: "x".repeat(CAPTION_MAX_LENGTH + 1), cta: "Buy", trialOffer: "One pack" }, claims);
  assert.equal(tooLong.checks.find((entry) => entry.name === "channel_limits")?.passed, false);

  const noLever = validateConcept({ ...base, caption: "short", cta: "", trialOffer: "" }, claims);
  assert.equal(noLever.checks.find((entry) => entry.name === "trial_lever")?.passed, false);
});

test("a cited claim cannot launder a prohibited term it does not contain", () => {
  // Cites the Assam claim, but writes "certified" — the exemption must not apply.
  const validation = validateConcept(
    {
      conceptName: "laundering",
      format: "feed_post",
      objective: "trial",
      hook: "Hook",
      caption: "Certified quality from Assam.",
      visualBrief: "A cup",
      cta: "Buy",
      trialOffer: "One pack",
      socialProofAngle: "Invite first buyers",
      hashtags: [],
      citedClaimIds: [claims[0].id],
      rationale: "why",
    },
    claims,
  );
  assert.equal(validation.checks.find((entry) => entry.name === "prohibited_terms")?.passed, false);
});

test("schema parser reports violations instead of returning a partial batch", () => {
  assert.deepEqual(parseConceptBatch({ concepts: [] }).violations.length > 0, true);
  assert.equal(parseConceptBatch({ concepts: [] }).batch, undefined);

  const missing = parseConceptBatch({ concepts: [{ conceptName: "only a name" }] });
  assert.equal(missing.batch, undefined);
  assert.ok(missing.violations.some((violation) => violation.path.endsWith(".hook")));

  const badEnum = parseConceptBatch({
    concepts: [{
      conceptName: "x", format: "tiktok", objective: "trial", hook: "h", caption: "c", visualBrief: "v",
      cta: "c", trialOffer: "t", socialProofAngle: "s", hashtags: [], citedClaimIds: ["a"], rationale: "r",
    }],
  });
  assert.ok(badEnum.violations.some((violation) => violation.path.endsWith(".format")));
});

test("provider output wrapped in prose or code fences is still parsed", () => {
  assert.deepEqual(parseJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonObject('Here you go: {"a":2} — hope that helps'), { a: 2 });
  assert.throws(() => parseJsonObject("no json at all"), /did not return JSON/);
});

test("every advertised provider id constructs", () => {
  for (const id of providerIds) {
    const provider = createProvider(id);
    assert.equal(typeof provider.model, "string");
    assert.equal(provider.isOfflineStub, id === "offline-template");
  }
  assert.throws(() => createProvider("nope"), /Unknown content provider/);
});

test("production never silently falls back to the offline generator", async () => {
  await assert.rejects(
    () => resolveProvider({ requested: "offline-template", environment: "production" }),
    /cannot be used in production/,
  );

  // Whether a real provider happens to be reachable on this machine varies, so
  // assert the invariant rather than one branch: production either resolves a
  // real provider or refuses, but never yields the stub.
  try {
    const resolved = await resolveProvider({ environment: "production" });
    assert.equal(resolved.provider.isOfflineStub, false, "Production resolved the offline stub.");
  } catch (error) {
    assert.match(
      error instanceof Error ? error.message : String(error),
      /No real content provider is available in production/,
    );
  }
});

test("development falls back to the offline generator and says so", async () => {
  const resolved = await resolveProvider({ environment: "development" });
  // Ollama or Anthropic may legitimately be configured on a developer machine.
  if (resolved.provider.isOfflineStub) {
    assert.match(resolved.reason, /placeholder copy/);
  } else {
    assert.ok(["ollama", "anthropic"].includes(resolved.provider.id));
  }
});

test("a non-uuid citation is rejected rather than reaching the database", () => {
  // A live qwen2.5:3b run returned "id=<uuid>", echoing the prompt's old prefix.
  // Validation must catch it; persistence must not pass it to a uuid column.
  const validation = validateConcept(
    {
      conceptName: "echoed prefix",
      format: "feed_post",
      objective: "trial",
      hook: "Hook",
      caption: "Caption",
      visualBrief: "Brief",
      cta: "Buy",
      trialOffer: "One pack",
      socialProofAngle: "Invite first buyers",
      hashtags: [],
      citedClaimIds: [`id=${claims[0].id}`],
      rationale: "why",
    },
    claims,
  );
  assert.equal(validation.valid, false);
  assert.equal(validation.checks.find((entry) => entry.name === "claim_citation")?.passed, false);
});

test("the user prompt lists bare identifiers with no prefix", () => {
  const prompt = buildUserPrompt(claims, { count: 1 });
  assert.equal(/id=/.test(prompt), false, "The prompt reintroduced an id= prefix a model can echo.");
  for (const claim of claims) assert.ok(prompt.includes(`- ${claim.id}`));
});
