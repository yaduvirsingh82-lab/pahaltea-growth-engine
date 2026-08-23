import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { PoolLike, Queryable } from "./client.ts";

/** One arbitrary but stable key so two runners can never migrate concurrently. */
export const MIGRATION_LOCK_KEY = 4_170_882_301;
const migrationFilePattern = /^\d{4}_[a-z0-9_]+\.sql$/;

export interface MigrationFile {
  version: string;
  filename: string;
  sql: string;
  checksum: string;
}

export interface MigrationResult {
  applied: readonly string[];
  alreadyApplied: readonly string[];
}

export async function loadMigrations(directory: URL): Promise<readonly MigrationFile[]> {
  const entries = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();

  const migrations: MigrationFile[] = [];
  for (const filename of entries) {
    if (!migrationFilePattern.test(filename)) {
      throw new Error(`Migration ${filename} must be named NNNN_snake_case.sql.`);
    }
    const sql = await readFile(new URL(filename, directory), "utf8");
    const version = filename.slice(0, 4);
    if (migrations.some((migration) => migration.version === version)) {
      throw new Error(`Duplicate migration version ${version}.`);
    }
    migrations.push({ version, filename, sql, checksum: checksumOf(sql) });
  }
  return migrations;
}

export function checksumOf(sql: string): string {
  // Normalise line endings so a Windows checkout and a Linux CI runner agree.
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/**
 * Applies pending migrations in version order. Each migration runs inside its
 * own transaction together with its ledger row, so a failure leaves the
 * database on the last fully applied version rather than half-migrated.
 */
export async function runMigrations(pool: PoolLike, directory: URL): Promise<MigrationResult> {
  const migrations = await loadMigrations(directory);
  const client = await pool.connect();

  try {
    await client.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_LOCK_KEY]);
    await ensureLedger(client);
    const recorded = await readLedger(client);

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const migration of migrations) {
      const existing = recorded.get(migration.version);
      if (existing) {
        if (existing.checksum !== migration.checksum) {
          throw new Error(
            `Migration ${migration.filename} changed after it was applied. Add a new migration instead of editing ${migration.version}.`,
          );
        }
        alreadyApplied.push(migration.filename);
        continue;
      }

      try {
        await client.query("BEGIN");
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO schema_migrations (version, filename, checksum) VALUES ($1, $2, $3)`,
          [migration.version, migration.filename, migration.checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`Migration ${migration.filename} failed and was rolled back: ${describe(error)}`);
      }
      applied.push(migration.filename);
    }

    return { applied, alreadyApplied };
  } finally {
    await client.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

async function ensureLedger(executor: Queryable): Promise<void> {
  await executor.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      filename text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function readLedger(executor: Queryable): Promise<Map<string, { checksum: string }>> {
  const result = await executor.query(`SELECT version, checksum FROM schema_migrations`);
  return new Map(result.rows.map((row) => [String(row.version), { checksum: String(row.checksum) }]));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
