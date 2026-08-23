import assert from "node:assert/strict";
import test from "node:test";
import { isApprovedClaim, type ProductClaim } from "../../domain/src/claims.ts";
import { validateContentClaims, type ContentDraft } from "../../domain/src/content.ts";
import { claimId, ORGANISATION_ID, seedClaims } from "../src/seed/catalogue.ts";
import { loadApprovedClaims, seedClaimCatalogue } from "../src/seed/run.ts";
import { createTestDatabase, databaseSkipReason, type TestDatabase } from "./support/database.ts";

const skip = databaseSkipReason();

test("claim catalogue seed", { skip, concurrency: false }, async (suite) => {
  let db: TestDatabase;
  suite.before(async () => (db = await createTestDatabase("seed")));
  suite.after(async () => await db.close());

  await suite.test("seeding writes the full catalogue with its evidence links", async () => {
    const summary = await seedClaimCatalogue(db.pool);

    assert.equal(summary.claimsChanged.length, seedClaims.length);
    assert.equal(summary.claimsUnchanged.length, 0);
    assert.equal(summary.approvedClaimCount, 10);
    assert.equal(summary.withheldClaimCount, 1);

    const counts = await db.pool.query(`SELECT status, count(*)::int AS total FROM claims GROUP BY status`);
    const byStatus = Object.fromEntries(counts.rows.map((row) => [row.status, row.total]));
    assert.equal(byStatus.approved, 10);
    assert.equal(byStatus.compliance_review, 1);

    const unlinked = await db.pool.query(
      `SELECT c.id FROM claims c LEFT JOIN claim_evidence_links l ON l.claim_id = c.id WHERE l.claim_id IS NULL`,
    );
    assert.equal(unlinked.rowCount, 0, "A claim was persisted without evidence.");
  });

  await suite.test("every seeded claim is recorded in the audit trail", async () => {
    const audit = await db.pool.query(
      `SELECT action, count(*)::int AS total FROM audit_events WHERE entity_type = 'claim' GROUP BY action`,
    );
    const byAction = Object.fromEntries(audit.rows.map((row) => [row.action, row.total]));
    assert.equal(byAction["claim.seeded_approved"], 10);
    assert.equal(byAction["claim.seeded_pending_owner_decision"], 1);
  });

  await suite.test("re-seeding changes nothing and adds no duplicate audit events", async () => {
    const before = await db.pool.query(`SELECT count(*)::int AS total FROM audit_events`);
    const summary = await seedClaimCatalogue(db.pool);
    const after = await db.pool.query(`SELECT count(*)::int AS total FROM audit_events`);

    assert.equal(summary.claimsChanged.length, 0);
    assert.equal(summary.claimsUnchanged.length, seedClaims.length);
    assert.equal(after.rows[0].total, before.rows[0].total, "Re-seeding appended redundant audit events.");

    const duplicates = await db.pool.query(`SELECT wording FROM claims GROUP BY wording HAVING count(*) > 1`);
    assert.equal(duplicates.rowCount, 0);
  });

  await suite.test("a changed claim is re-audited and its version is bumped", async () => {
    const id = claimId("origin-assam");
    await db.pool.query(`UPDATE claims SET wording = 'Origin/garden: elsewhere' WHERE id = $1`, [id]);

    const summary = await seedClaimCatalogue(db.pool);
    assert.deepEqual(summary.claimsChanged, ["origin-assam"]);

    const restored = await db.pool.query(`SELECT wording, version FROM claims WHERE id = $1`, [id]);
    assert.equal(restored.rows[0].wording, "Origin/garden: Assam");
    assert.equal(Number(restored.rows[0].version), 2);
  });

  await suite.test("claims read back from the database satisfy the domain validator", async () => {
    const rows = await loadApprovedClaims(db.pool, ORGANISATION_ID);
    assert.equal(rows.length, seedClaims.length);

    const claims = rows as unknown as ProductClaim[];
    assert.equal(claims.filter(isApprovedClaim).length, 10);

    const draft = (citedClaimIds: string[]): ContentDraft => ({
      id: "draft-1",
      organisationId: ORGANISATION_ID,
      channel: "instagram",
      body: "A caption drafted from approved product truth.",
      citedClaimIds,
      status: "draft",
      createdBy: "test",
    });

    const good = validateContentClaims(
      draft([claimId("origin-assam"), claimId("no-additives"), claimId("hero-sku-pack")]),
      claims,
    );
    assert.equal(good.valid, true, good.reasons.join(" "));

    const withheld = validateContentClaims(draft([claimId("ethically-grown")]), claims);
    assert.equal(withheld.valid, false, "The withheld claim was citable from the database.");

    const uncited = validateContentClaims(draft([]), claims);
    assert.equal(uncited.valid, false);
  });

  await suite.test("the seeded catalogue is scoped to one organisation", async () => {
    const foreign = await db.pool.query(`SELECT count(*)::int AS total FROM claims WHERE organisation_id <> $1`, [
      ORGANISATION_ID,
    ]);
    assert.equal(foreign.rows[0].total, 0);
  });
});
