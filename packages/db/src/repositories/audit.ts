import type { AuditEventInput, AuditRepository } from "../../../domain/src/audit.ts";
import type { Queryable } from "../client.ts";

/**
 * Append-only by construction: this class exposes no update or delete path, and
 * `audit_events` carries a BEFORE UPDATE OR DELETE trigger that rejects both at
 * the database level (migration 0001).
 */
export class PostgresAuditRepository implements AuditRepository {
  readonly #executor: Queryable;

  constructor(executor: Queryable) {
    this.#executor = executor;
  }

  async append(event: AuditEventInput): Promise<void> {
    await this.#executor.query(
      `INSERT INTO audit_events
         (organisation_id, actor_id, action, entity_type, entity_id, payload_hash, correlation_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        event.organisationId,
        event.actorId,
        event.action,
        event.entityType,
        event.entityId,
        event.payloadHash,
        event.correlationId,
        event.occurredAt,
      ],
    );
  }
}
