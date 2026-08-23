import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { checksumOf, loadMigrations, runMigrations } from "../src/migrate.ts";
import { createTestDatabase, databaseSkipReason, type TestDatabase } from "./support/database.ts";

const skip = databaseSkipReason();
const realMigrations = new URL("../migrations/", import.meta.url);

test("migration loader rejects malformed and duplicated versions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pahaltea-migrations-"));
  try {
    await writeFile(join(directory, "not-numbered.sql"), "SELECT 1;");
    await assert.rejects(() => loadMigrations(directoryUrl(directory)), /NNNN_snake_case\.sql/);

    await rm(join(directory, "not-numbered.sql"));
    await writeFile(join(directory, "0001_first.sql"), "SELECT 1;");
    await writeFile(join(directory, "0001_second.sql"), "SELECT 2;");
    await assert.rejects(() => loadMigrations(directoryUrl(directory)), /Duplicate migration version 0001/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checksums ignore line-ending differences between Windows and CI", () => {
  assert.equal(checksumOf("CREATE TABLE a();\nSELECT 1;\n"), checksumOf("CREATE TABLE a();\r\nSELECT 1;\r\n"));
});

test("every committed migration is loadable and ordered", async () => {
  const migrations = await loadMigrations(realMigrations);
  const files = (await readdir(realMigrations)).filter((name) => name.endsWith(".sql"));
  assert.equal(migrations.length, files.length);
  assert.deepEqual([...migrations].map((m) => m.version).sort(), migrations.map((m) => m.version));
});

test("migration runner", { skip, concurrency: false }, async (suite) => {
  let db: TestDatabase;
  suite.before(async () => (db = await createTestDatabase("migrate")));
  suite.after(async () => await db.close());

  await suite.test("a migrated schema records every migration exactly once", async () => {
    // createTestDatabase already ran them; a second run must be a no-op.
    const result = await runMigrations(db.pool, realMigrations);
    assert.equal(result.applied.length, 0);
    assert.ok(result.alreadyApplied.length >= 3);

    const ledger = await db.pool.query(`SELECT version, count(*) FROM schema_migrations GROUP BY version`);
    for (const row of ledger.rows) assert.equal(Number(row.count), 1);
  });

  await suite.test("the expected tables and the append-only trigger exist", async () => {
    const tables = await db.pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [db.schema],
    );
    const names = tables.rows.map((row) => String(row.table_name));
    for (const expected of [
      "approval_decisions",
      "approval_requests",
      "audit_events",
      "claims",
      "content_drafts",
      "idempotency_keys",
      "integration_connections",
      "organisations",
      "outbox_events",
      "schema_migrations",
      "webhook_events",
    ]) {
      assert.ok(names.includes(expected), `Missing table ${expected}.`);
    }

    const trigger = await db.pool.query(
      `SELECT 1 FROM information_schema.triggers
        WHERE trigger_schema = $1 AND event_object_table = 'audit_events' AND trigger_name = 'audit_events_append_only'`,
      [db.schema],
    );
    assert.ok((trigger.rowCount ?? 0) > 0, "The append-only trigger is missing.");
  });

  await suite.test("an edited applied migration is refused instead of silently re-run", async () => {
    await db.pool.query(`UPDATE schema_migrations SET checksum = 'tampered' WHERE version = '0001'`);
    await assert.rejects(() => runMigrations(db.pool, realMigrations), /changed after it was applied/);
    // Restore so later assertions in this suite still see a coherent ledger.
    const [first] = await loadMigrations(realMigrations);
    await db.pool.query(`UPDATE schema_migrations SET checksum = $1 WHERE version = '0001'`, [first.checksum]);
  });

  await suite.test("a failing migration rolls back and is not recorded as applied", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pahaltea-bad-migration-"));
    try {
      await writeFile(join(directory, "0001_creates_a_table.sql"), "CREATE TABLE ok_table (id int);");
      await writeFile(join(directory, "0002_is_invalid.sql"), "CREATE TABLE broken (id int); SELECT nonexistent_fn();");

      const isolated = await createTestDatabase("badmigration", { migrate: false });
      try {
        await assert.rejects(() => runMigrations(isolated.pool, directoryUrl(directory)), /0002_is_invalid\.sql failed/);

        const ledger = await isolated.pool.query(`SELECT version FROM schema_migrations WHERE version = '0002'`);
        assert.equal(ledger.rowCount, 0, "A failed migration was recorded as applied.");

        const leftover = await isolated.pool.query(
          `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'broken'`,
          [isolated.schema],
        );
        assert.equal(leftover.rowCount, 0, "A failed migration left a table behind.");
      } finally {
        await isolated.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function directoryUrl(path: string): URL {
  return new URL(`${pathToFileURL(path).href}/`);
}
