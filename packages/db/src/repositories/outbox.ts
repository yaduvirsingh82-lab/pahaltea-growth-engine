import type { OutboxEventInput, OutboxRepository } from "../../../domain/src/audit.ts";
import type { Queryable } from "../client.ts";

export interface OutboxRecord {
  id: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  status: "pending" | "processing" | "delivered" | "failed";
}

/**
 * Enqueue is idempotent on `idempotency_key`: retrying the same logical event
 * cannot produce a second external side effect. Nothing here dispatches; a
 * worker claims rows only after the approval policy has authorised the action.
 */
export class PostgresOutboxRepository implements OutboxRepository {
  readonly #executor: Queryable;

  constructor(executor: Queryable) {
    this.#executor = executor;
  }

  async enqueue(event: OutboxEventInput): Promise<void> {
    await this.#executor.query(
      `INSERT INTO outbox_events
         (organisation_id, topic, aggregate_type, aggregate_id, payload, idempotency_key, occurred_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        event.organisationId,
        event.topic,
        event.aggregateType,
        event.aggregateId,
        JSON.stringify(event.payload),
        event.idempotencyKey,
        event.occurredAt,
      ],
    );
  }

  async pending(organisationId: string, limit = 50): Promise<readonly OutboxRecord[]> {
    const result = await this.#executor.query(
      `SELECT id, topic, aggregate_type, aggregate_id, payload, idempotency_key, status
         FROM outbox_events
        WHERE organisation_id = $1 AND status IN ('pending', 'failed')
        ORDER BY created_at
        LIMIT $2`,
      [organisationId, limit],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      topic: String(row.topic),
      aggregateType: String(row.aggregate_type),
      aggregateId: String(row.aggregate_id),
      payload: row.payload as Record<string, unknown>,
      idempotencyKey: String(row.idempotency_key),
      status: row.status as OutboxRecord["status"],
    }));
  }
}
