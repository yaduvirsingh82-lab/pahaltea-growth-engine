import type { IdempotencyRepository } from "../../../domain/src/integrations.ts";
import type { Queryable } from "../client.ts";

/**
 * Keys are scoped to an organisation because `idempotency_keys` is unique on
 * `(organisation_id, key)`. The domain port deliberately takes only the key, so
 * the tenant boundary is bound once, here, rather than at every call site.
 */
export class PostgresIdempotencyRepository implements IdempotencyRepository {
  readonly #executor: Queryable;
  readonly #organisationId: string;

  constructor(executor: Queryable, organisationId: string) {
    this.#executor = executor;
    this.#organisationId = organisationId;
  }

  /**
   * A single atomic statement. The row is claimed when it does not exist, or
   * when the previous claim has already expired; a live claim yields no row and
   * the caller must treat the work as already handled.
   */
  async reserve(key: string, expiresAt: Date): Promise<boolean> {
    const result = await this.#executor.query(
      `INSERT INTO idempotency_keys (organisation_id, key, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (organisation_id, key) DO UPDATE
         SET expires_at = EXCLUDED.expires_at
       WHERE idempotency_keys.expires_at <= now()
       RETURNING id`,
      [this.#organisationId, key, expiresAt],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Housekeeping for expired claims. Never removes a live reservation. */
  async purgeExpired(now: Date = new Date()): Promise<number> {
    const result = await this.#executor.query(
      `DELETE FROM idempotency_keys WHERE organisation_id = $1 AND expires_at <= $2`,
      [this.#organisationId, now],
    );
    return result.rowCount ?? 0;
  }
}
