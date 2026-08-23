import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { withTransaction } from "../src/client.ts";
import { PostgresAuditRepository } from "../src/repositories/audit.ts";
import { PostgresIdempotencyRepository } from "../src/repositories/idempotency.ts";
import { PostgresOutboxRepository } from "../src/repositories/outbox.ts";
import { createTestDatabase, databaseSkipReason, insertOrganisation, type TestDatabase } from "./support/database.ts";

const skip = databaseSkipReason();

test("repository integration", { skip, concurrency: false }, async (suite) => {
  let db: TestDatabase;
  let organisationId: string;

  suite.before(async () => {
    db = await createTestDatabase("repos");
    organisationId = await insertOrganisation(db.pool, "Pahal Tea (test)");
  });
  suite.after(async () => await db.close());

  await suite.test("audit events are written and are append-only in the database", async () => {
    const audit = new PostgresAuditRepository(db.pool);
    const entityId = randomUUID();
    await audit.append({
      organisationId,
      actorId: randomUUID(),
      action: "claim.seeded_approved",
      entityType: "claim",
      entityId,
      payloadHash: "a".repeat(64),
      correlationId: randomUUID(),
      occurredAt: new Date(),
    });

    const stored = await db.pool.query(`SELECT action FROM audit_events WHERE entity_id = $1`, [entityId]);
    assert.equal(stored.rowCount, 1);

    await assert.rejects(
      () => db.pool.query(`UPDATE audit_events SET action = 'tampered' WHERE entity_id = $1`, [entityId]),
      /append-only/,
    );
    await assert.rejects(
      () => db.pool.query(`DELETE FROM audit_events WHERE entity_id = $1`, [entityId]),
      /append-only/,
    );
  });

  await suite.test("a failed transaction rolls the audit event back with its mutation", async () => {
    const entityId = randomUUID();
    await assert.rejects(
      withTransaction(db.pool, async (tx) => {
        await new PostgresAuditRepository(tx).append({
          organisationId,
          actorId: null,
          action: "claim.attempted",
          entityType: "claim",
          entityId,
          payloadHash: "b".repeat(64),
          correlationId: randomUUID(),
          occurredAt: new Date(),
        });
        throw new Error("domain mutation failed");
      }),
      /domain mutation failed/,
    );

    const stored = await db.pool.query(`SELECT 1 FROM audit_events WHERE entity_id = $1`, [entityId]);
    assert.equal(stored.rowCount, 0, "Audit event survived a rolled-back transaction.");
  });

  await suite.test("outbox enqueue is idempotent on the idempotency key", async () => {
    const outbox = new PostgresOutboxRepository(db.pool);
    const idempotencyKey = `content.publish:${randomUUID()}`;
    const event = {
      organisationId,
      topic: "content.publish",
      aggregateType: "content_draft",
      aggregateId: randomUUID(),
      payload: { channel: "instagram", citedClaimIds: ["claim-1"] },
      idempotencyKey,
      occurredAt: new Date(),
    };

    await outbox.enqueue(event);
    await outbox.enqueue(event);

    const stored = await db.pool.query(`SELECT payload FROM outbox_events WHERE idempotency_key = $1`, [idempotencyKey]);
    assert.equal(stored.rowCount, 1, "A retried enqueue created a second side effect.");
    assert.deepEqual(stored.rows[0].payload, event.payload);

    const pending = await outbox.pending(organisationId);
    assert.ok(pending.some((record) => record.idempotencyKey === idempotencyKey && record.status === "pending"));
  });

  await suite.test("an idempotency key can be reserved once, and again only after it expires", async () => {
    const repository = new PostgresIdempotencyRepository(db.pool, organisationId);
    const key = `shopify:orders/create:${randomUUID()}`;
    const inOneDay = new Date(Date.now() + 86_400_000);

    assert.equal(await repository.reserve(key, inOneDay), true);
    assert.equal(await repository.reserve(key, inOneDay), false, "A live reservation was handed out twice.");

    const expiredKey = `meta:comment:${randomUUID()}`;
    assert.equal(await repository.reserve(expiredKey, new Date(Date.now() - 1_000)), true);
    assert.equal(await repository.reserve(expiredKey, inOneDay), true, "An expired reservation was not reclaimable.");
  });

  await suite.test("concurrent reservations of the same key yield exactly one winner", async () => {
    const key = `meta:webhook:${randomUUID()}`;
    const expiresAt = new Date(Date.now() + 86_400_000);

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => new PostgresIdempotencyRepository(db.pool, organisationId).reserve(key, expiresAt)),
    );

    assert.equal(outcomes.filter(Boolean).length, 1, `Expected one winner, got ${outcomes.filter(Boolean).length}.`);
  });

  await suite.test("purging expired keys never removes a live reservation", async () => {
    const repository = new PostgresIdempotencyRepository(db.pool, organisationId);
    const live = `live:${randomUUID()}`;
    const dead = `dead:${randomUUID()}`;

    await repository.reserve(live, new Date(Date.now() + 86_400_000));
    await repository.reserve(dead, new Date(Date.now() - 1_000));

    const purged = await repository.purgeExpired();
    assert.ok(purged >= 1);
    assert.equal(await repository.reserve(live, new Date(Date.now() + 86_400_000)), false, "A live reservation was purged.");
  });

  await suite.test("an integration connection cannot be enabled without a recorded approval", async () => {
    await assert.rejects(
      () =>
        db.pool.query(
          `INSERT INTO integration_connections (organisation_id, provider, mode, account_id, credential_reference, enabled)
           VALUES ($1, 'instagram', 'read_only', 'acct-1', 'secret://managed/ig', true)`,
          [organisationId],
        ),
      /integration_connections_check/,
      "An unapproved connection was allowed to be enabled.",
    );
  });
});
