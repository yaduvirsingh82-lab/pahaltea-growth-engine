import pg from "pg";

/**
 * The minimal surface every repository needs. Accepting this instead of a
 * concrete `Pool` lets a caller pass an in-transaction client so that a domain
 * mutation, its audit event, and its outbox event commit or roll back together.
 */
export interface Queryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

export interface PoolLike extends Queryable {
  connect(): Promise<PoolClientLike>;
  end(): Promise<void>;
}

export interface PoolClientLike extends Queryable {
  release(): void;
}

export function createPool(databaseUrl: string | undefined = process.env.DATABASE_URL): PoolLike {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured. Start the local database with `docker compose up -d postgres`.");
  }
  return new pg.Pool({
    connectionString: databaseUrl,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "pahaltea-growth-engine",
  }) as unknown as PoolLike;
}

/**
 * Runs `work` inside a single transaction. Any thrown error rolls the whole
 * unit back, which is what keeps the audit trail consistent with the mutation
 * that produced it.
 */
export async function withTransaction<T>(pool: PoolLike, work: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
