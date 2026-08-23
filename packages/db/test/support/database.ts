import pg from "pg";
import type { PoolLike } from "../../src/client.ts";
import { MIGRATION_LOCK_KEY, runMigrations } from "../../src/migrate.ts";

const migrationsDirectory = new URL("../../migrations/", import.meta.url);

/**
 * CI must never silently pass because no database was reachable. When
 * REQUIRE_DB_TESTS is set, a missing DATABASE_URL is a failure, not a skip.
 */
export function databaseSkipReason(): string | false {
  if (process.env.DATABASE_URL) return false;
  if (process.env.REQUIRE_DB_TESTS === "true") {
    throw new Error("REQUIRE_DB_TESTS=true but DATABASE_URL is not set; integration tests cannot be skipped here.");
  }
  return "DATABASE_URL is not set. Run `npm run db:up` to enable integration tests.";
}

export interface TestDatabase {
  pool: PoolLike;
  schema: string;
  close(): Promise<void>;
}

let schemaCounter = 0;

/**
 * Each suite gets its own migrated schema so tests cannot see one another's
 * rows and never touch the developer's seeded catalogue. Pass
 * `{ migrate: false }` to get an empty schema for testing the runner itself.
 */
export async function createTestDatabase(label: string, options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required.");

  const schema = `test_${label}_${process.pid}_${++schemaCounter}`;
  const admin = new pg.Pool({ connectionString, max: 1 });
  try {
    // pgcrypto is database-wide, and CREATE EXTENSION IF NOT EXISTS is NOT
    // atomic: parallel test files racing on a cold database hit a duplicate key
    // on pg_extension_name_index. Serialise on the same advisory lock the
    // migration runner uses. Migration 0001's IF NOT EXISTS then no-ops.
    await admin.query("BEGIN");
    await admin.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await admin.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
    await admin.query("COMMIT");
    await admin.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    await admin.end();
  }

  const pool = new pg.Pool({
    connectionString,
    max: 8,
    options: `-c search_path="${schema}",public`,
  }) as unknown as PoolLike;

  if (options.migrate !== false) await runMigrations(pool, migrationsDirectory);

  return {
    pool,
    schema,
    async close() {
      await pool.end();
      const cleanup = new pg.Pool({ connectionString, max: 1 });
      try {
        await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

export async function insertOrganisation(pool: PoolLike, name = "Test Org"): Promise<string> {
  const result = await pool.query(`INSERT INTO organisations (name) VALUES ($1) RETURNING id`, [name]);
  return String(result.rows[0].id);
}
