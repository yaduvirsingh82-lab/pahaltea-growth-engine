import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isApprovedClaim, type ProductClaim } from "../../domain/src/claims.ts";
import { validateContentClaims, type ContentDraft } from "../../domain/src/content.ts";
import { claimId, evidenceId, ORGANISATION_ID, seedClaims, seedEvidence } from "../src/seed/catalogue.ts";
import { uuidV5 } from "../src/uuid.ts";

const agentsUrl = new URL("../../../AGENTS.md", import.meta.url);

/** Reads the permitted-facts bullet list straight out of AGENTS.md. */
async function permittedFactsFromAgentsMd(): Promise<string[]> {
  const markdown = await readFile(agentsUrl, "utf8");
  const section = markdown.split("the permitted facts for Masala Tea are:")[1];
  assert.ok(section, "AGENTS.md no longer contains the permitted-facts preamble.");

  return section
    .split(/\n\s*\n/)[1]
    .split("\n")
    .filter((line) => line.startsWith("- "))
    // A trailing parenthetical in AGENTS.md is an editorial note about the
    // fact's durability, not part of the claim wording itself.
    .map((line) => line.slice(2).replace(/\s*\([^()]*\)\s*$/, "").trim());
}

test("every permitted fact in AGENTS.md is transcribed into the seed catalogue", async () => {
  const permitted = await permittedFactsFromAgentsMd();
  const seeded = seedClaims.map((claim) => claim.wording);

  assert.deepEqual(seeded, permitted, "Seed catalogue has drifted from AGENTS.md.");
});

test("the seed catalogue invents no claim that AGENTS.md does not permit", async () => {
  const permitted = new Set(await permittedFactsFromAgentsMd());
  for (const claim of seedClaims) {
    assert.ok(permitted.has(claim.wording), `Claim "${claim.wording}" is not in the approved catalogue.`);
  }
});

test("no seeded claim can reach approved status without evidence", () => {
  for (const claim of seedClaims) {
    assert.ok(claim.evidenceKeys.length > 0, `Claim ${claim.key} has no evidence.`);
    for (const key of claim.evidenceKeys) {
      assert.ok(seedEvidence.some((evidence) => evidence.key === key), `Unknown evidence key ${key}.`);
    }
  }
});

test("no seeded evidence fabricates a certification", () => {
  for (const evidence of seedEvidence) {
    assert.notEqual(evidence.sourceType, "certification");
  }
});

test("claims flagged by an unresolved owner decision are withheld from approved status", () => {
  const withheld = seedClaims.filter((claim) => claim.status !== "approved");
  assert.equal(withheld.length, 1);
  assert.match(withheld[0].wording, /^Ethically Grown:/);
  assert.match(withheld[0].withheldReason ?? "", /docs\/ARCHITECTURE\.md/);
});

test("approved seeded claims satisfy the domain approval predicate", () => {
  for (const claim of materialise()) {
    const expected = seedClaims.find((seed) => claimId(seed.key) === claim.id)?.status === "approved";
    assert.equal(isApprovedClaim(claim), expected, `Wrong approval state for ${claim.wording}.`);
  }
});

test("content citing the withheld claim fails validation, content citing approved claims passes", () => {
  const claims = materialise();
  const approved = seedClaims.find((claim) => claim.status === "approved");
  const withheld = seedClaims.find((claim) => claim.status !== "approved");
  assert.ok(approved && withheld);

  const draft = (citedClaimIds: string[]): ContentDraft => ({
    id: "draft-1",
    organisationId: ORGANISATION_ID,
    channel: "instagram",
    body: "caption under review",
    citedClaimIds,
    status: "draft",
    createdBy: "test",
  });

  assert.equal(validateContentClaims(draft([claimId(approved.key)]), claims).valid, true);

  const rejected = validateContentClaims(draft([claimId(withheld.key)]), claims);
  assert.equal(rejected.valid, false);
  assert.match(rejected.reasons.join(" "), /is not currently approved with evidence/);
});

test("seed identifiers are deterministic across runs", () => {
  assert.equal(claimId("origin-assam"), claimId("origin-assam"));
  assert.notEqual(claimId("origin-assam"), claimId("grade-amchong"));
  assert.match(uuidV5("anything"), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(new Set(seedClaims.map((claim) => claimId(claim.key))).size, seedClaims.length);
  assert.equal(new Set(seedEvidence.map((evidence) => evidenceId(evidence.key))).size, seedEvidence.length);
});

function materialise(): ProductClaim[] {
  const approvedAt = new Date("2026-08-23T00:00:00Z");
  return seedClaims.map((claim) => ({
    id: claimId(claim.key),
    productId: "product",
    wording: claim.wording,
    status: claim.status,
    version: 1,
    evidence: claim.evidenceKeys.map((key) => ({
      id: evidenceId(key),
      sourceType: seedEvidence.find((evidence) => evidence.key === key)!.sourceType,
      reference: key,
    })),
    approvedAt: claim.status === "approved" ? approvedAt : undefined,
    approvedBy: claim.status === "approved" ? "owner" : undefined,
  }));
}
