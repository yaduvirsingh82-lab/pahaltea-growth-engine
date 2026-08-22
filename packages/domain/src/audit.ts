export interface AuditEventInput {
  organisationId: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  payloadHash: string;
  correlationId: string;
  occurredAt: Date;
}

export interface OutboxEventInput {
  organisationId: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: Readonly<Record<string, unknown>>;
  idempotencyKey: string;
  occurredAt: Date;
}

/**
 * Repository ports preserve the append-only invariant. Implementations must
 * reject updates/deletes and write the audit and outbox record transactionally
 * with the domain mutation that triggered them.
 */
export interface AuditRepository {
  append(event: AuditEventInput): Promise<void>;
}

export interface OutboxRepository {
  enqueue(event: OutboxEventInput): Promise<void>;
}
