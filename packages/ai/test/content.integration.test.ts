import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createTestDatabase, databaseSkipReason, type TestDatabase } from "../../db/test/support/database.ts";
import { ORGANISATION_ID, claimId } from "../../db/src/seed/catalogue.ts";
import { seedClaimCatalogue } from "../../db/src/seed/run.ts";
import { generateInstagramConcepts } from "../src/generate.ts";
import { OfflineTemplateProvider } from "../src/providers/offline.ts";
import { retrieveApprovedClaims } from "../src/retrieval.ts";
import { getDraft, listDrafts, reviewDraft } from "../src/review.ts";

const skip = databaseSkipReason();

test("content generation and review", { skip, concurrency: false }, async (suite) => {
  let db: TestDatabase;
  const reviewer = randomUUID();
  const creator = randomUUID();

  suite.before(async () => {
    db = await createTestDatabase("content");
    await seedClaimCatalogue(db.pool);
  });
  suite.after(async () => await db.close());

  await suite.test("retrieval returns only approved, evidenced claims", async () => {
    const snapshot = await retrieveApprovedClaims(db.pool, ORGANISATION_ID);

    assert.equal(snapshot.claims.length, 10, "Expected the 10 approved claims, not the withheld one.");
    assert.equal(
      snapshot.claims.some((claim) => claim.wording.startsWith("Ethically Grown")),
      false,
      "The claim awaiting an owner decision reached the retrieval layer.",
    );
    assert.match(snapshot.hash, /^[0-9a-f]{64}$/);
    for (const claim of snapshot.claims) assert.ok(claim.evidenceReferences.length > 0);
  });

  await suite.test("the withheld claim is invisible to the prompt even by id", async () => {
    const snapshot = await retrieveApprovedClaims(db.pool, ORGANISATION_ID);
    const withheldId = claimId("ethically-grown");
    assert.equal(snapshot.claims.some((claim) => claim.id === withheldId), false);
  });

  await suite.test("generation persists drafts, citations, checks, run provenance and audit events", async () => {
    const outcome = await generateInstagramConcepts(db.pool, {
      organisationId: ORGANISATION_ID,
      createdBy: creator,
      provider: new OfflineTemplateProvider(),
      environment: "development",
      count: 4,
    });

    assert.equal(outcome.drafts.length, 4);
    assert.equal(outcome.rejected, 0, "Offline concepts should pass every check.");
    assert.equal(outcome.isOfflineStub, true);

    const run = await db.pool.query(
      `SELECT status, is_offline_stub, prompt_template_name, prompt_template_version, retrieval_snapshot_hash
         FROM generation_runs WHERE id = $1`,
      [outcome.runId],
    );
    assert.equal(run.rows[0].status, "succeeded");
    assert.equal(run.rows[0].is_offline_stub, true);
    assert.equal(run.rows[0].prompt_template_name, "instagram_concepts");
    assert.equal(run.rows[0].retrieval_snapshot_hash, outcome.retrievalSnapshotHash);

    const snapshotRow = await db.pool.query(`SELECT claim_ids FROM retrieval_snapshots WHERE hash = $1`, [
      outcome.retrievalSnapshotHash,
    ]);
    assert.equal((snapshotRow.rows[0].claim_ids as string[]).length, 10);

    const citations = await db.pool.query(
      `SELECT count(*)::int AS total FROM content_claim_citations WHERE content_draft_id = $1`,
      [outcome.drafts[0].id],
    );
    assert.ok(citations.rows[0].total > 0, "Draft has no persisted claim citations.");

    const checks = await db.pool.query(
      `SELECT check_name, passed FROM content_validation_results WHERE content_draft_id = $1 ORDER BY check_name`,
      [outcome.drafts[0].id],
    );
    assert.deepEqual(
      checks.rows.map((row) => row.check_name),
      ["channel_limits", "claim_citation", "prohibited_terms", "trial_lever"],
    );
    assert.ok(checks.rows.every((row) => row.passed === true));

    const audit = await db.pool.query(
      `SELECT count(*)::int AS total FROM audit_events WHERE action = 'content.generated'`,
    );
    assert.equal(audit.rows[0].total, 4);
  });

  await suite.test("generated drafts stop at claim_validation and never reach a publishable state", async () => {
    const drafts = await listDrafts(db.pool, ORGANISATION_ID);
    assert.ok(drafts.length >= 4);
    for (const draft of drafts) {
      assert.ok(
        ["claim_validation", "failed"].includes(draft.status),
        `Draft ${draft.id} was persisted as ${draft.status}.`,
      );
      assert.equal(draft.isOfflineStub, true);
    }
  });

  await suite.test("a draft cannot be approved by the actor that created it", async () => {
    const [draft] = await listDrafts(db.pool, ORGANISATION_ID, { status: "claim_validation" });
    const result = await reviewDraft(db.pool, {
      draftId: draft.id,
      reviewerId: creator,
      reviewerRoles: ["marketing_approver"],
      decision: "approved",
      environment: "development",
    });
    assert.equal(result.applied, false);
    assert.match(result.reason, /cannot be reviewed by the actor who created it/);
  });

  await suite.test("a draft cannot be approved by an ineligible role", async () => {
    const [draft] = await listDrafts(db.pool, ORGANISATION_ID, { status: "claim_validation" });
    const result = await reviewDraft(db.pool, {
      draftId: draft.id,
      reviewerId: reviewer,
      reviewerRoles: ["viewer"],
      decision: "approved",
      environment: "development",
    });
    assert.equal(result.applied, false);
    assert.match(result.reason, /Review requires one of/);
  });

  await suite.test("an eligible, segregated approver releases the draft and records the approval", async () => {
    const [draft] = await listDrafts(db.pool, ORGANISATION_ID, { status: "claim_validation" });
    const result = await reviewDraft(db.pool, {
      draftId: draft.id,
      reviewerId: reviewer,
      reviewerRoles: ["marketing_approver"],
      decision: "approved",
      note: "Reads well, on strategy.",
      environment: "development",
    });

    assert.equal(result.applied, true, result.reason);
    assert.equal(result.status, "approved");

    const stored = await getDraft(db.pool, draft.id);
    assert.equal(stored?.status, "approved");
    assert.equal(stored?.reviewedBy, reviewer);
    assert.equal(stored?.reviewNote, "Reads well, on strategy.");

    // The approval must be a real, payload-bound record, not a status flip.
    const approval = await db.pool.query(
      `SELECT r.action_kind, r.payload_hash, d.approver_id, d.decision
         FROM approval_requests r JOIN approval_decisions d ON d.approval_request_id = r.id
        WHERE r.organisation_id = $1 ORDER BY r.created_at DESC LIMIT 1`,
      [ORGANISATION_ID],
    );
    assert.equal(approval.rows[0].action_kind, "content.publish");
    assert.equal(approval.rows[0].approver_id, reviewer);
    assert.equal(approval.rows[0].decision, "approved");
    assert.match(String(approval.rows[0].payload_hash), /^[0-9a-f]{64}$/);

    const audit = await db.pool.query(
      `SELECT count(*)::int AS total FROM audit_events WHERE action = 'content.review_approved' AND entity_id = $1`,
      [draft.id],
    );
    assert.equal(audit.rows[0].total, 1);
  });

  await suite.test("approval is refused while any validation check is failing", async () => {
    const [draft] = await listDrafts(db.pool, ORGANISATION_ID, { status: "claim_validation" });
    await db.pool.query(
      `INSERT INTO content_validation_results (content_draft_id, check_name, passed, detail)
       VALUES ($1, 'prohibited_terms', false, 'injected failure')
       ON CONFLICT (content_draft_id, check_name) DO UPDATE SET passed = false, detail = 'injected failure'`,
      [draft.id],
    );

    const result = await reviewDraft(db.pool, {
      draftId: draft.id,
      reviewerId: reviewer,
      reviewerRoles: ["marketing_approver"],
      decision: "approved",
      environment: "development",
    });
    assert.equal(result.applied, false);
    assert.match(result.reason, /failing checks: prohibited_terms/);
  });

  await suite.test("rejection archives the draft and records the decision", async () => {
    const [draft] = await listDrafts(db.pool, ORGANISATION_ID, { status: "claim_validation" });
    const result = await reviewDraft(db.pool, {
      draftId: draft.id,
      reviewerId: reviewer,
      reviewerRoles: ["owner"],
      decision: "rejected",
      note: "Off strategy.",
      environment: "development",
    });

    assert.equal(result.applied, true);
    assert.equal(result.status, "archived");

    const audit = await db.pool.query(
      `SELECT count(*)::int AS total FROM audit_events WHERE action = 'content.review_rejected' AND entity_id = $1`,
      [draft.id],
    );
    assert.equal(audit.rows[0].total, 1);
  });

  await suite.test("a failed provider marks the run failed and persists no drafts", async () => {
    const before = await db.pool.query(`SELECT count(*)::int AS total FROM content_drafts`);

    const exploding = {
      id: "exploding",
      model: "none",
      isOfflineStub: false,
      available: async () => ({ available: true, detail: "test double" }),
      generate: async () => {
        throw new Error("provider exploded");
      },
    };

    await assert.rejects(
      () =>
        generateInstagramConcepts(db.pool, {
          organisationId: ORGANISATION_ID,
          createdBy: creator,
          provider: exploding,
          environment: "development",
          count: 2,
        }),
      /provider exploded/,
    );

    const after = await db.pool.query(`SELECT count(*)::int AS total FROM content_drafts`);
    assert.equal(after.rows[0].total, before.rows[0].total, "A failed run persisted drafts.");

    const run = await db.pool.query(
      `SELECT status, error FROM generation_runs WHERE provider = 'exploding' ORDER BY started_at DESC LIMIT 1`,
    );
    assert.equal(run.rows[0].status, "failed");
    assert.match(String(run.rows[0].error), /provider exploded/);
  });

  await suite.test("a schema-violating provider fails the run rather than persisting junk", async () => {
    const malformed = {
      id: "malformed",
      model: "none",
      isOfflineStub: false,
      available: async () => ({ available: true, detail: "test double" }),
      generate: async () => ({
        provider: "malformed",
        model: "none",
        raw: '{"concepts":[{"conceptName":"x"}]}',
        parsed: { concepts: [{ conceptName: "x" }] },
        usage: {},
      }),
    };

    await assert.rejects(
      () =>
        generateInstagramConcepts(db.pool, {
          organisationId: ORGANISATION_ID,
          createdBy: creator,
          provider: malformed,
          environment: "development",
          count: 1,
        }),
      /did not match the concept schema/,
    );
  });

  await suite.test("generation refuses to run the offline generator in production", async () => {
    await assert.rejects(
      () =>
        generateInstagramConcepts(db.pool, {
          organisationId: ORGANISATION_ID,
          createdBy: creator,
          provider: new OfflineTemplateProvider(),
          environment: "production",
          count: 1,
        }),
      /cannot run in production/,
    );
  });

  await suite.test("generation refuses when the organisation has no approved claims", async () => {
    const empty = await createTestDatabase("noclaims");
    try {
      const org = await empty.pool.query(`INSERT INTO organisations (name) VALUES ('Empty') RETURNING id`);
      await assert.rejects(
        () =>
          generateInstagramConcepts(empty.pool, {
            organisationId: String(org.rows[0].id),
            createdBy: creator,
            provider: new OfflineTemplateProvider(),
            environment: "development",
            count: 1,
          }),
        /No approved claims are available/,
      );
    } finally {
      await empty.close();
    }
  });
});
