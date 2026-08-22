-- Phase 2 foundation migration. Apply only through an approved release process.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organisations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  action_kind text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development', 'staging', 'production')),
  actor_id uuid NOT NULL,
  payload_hash text NOT NULL,
  risk_level text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')) DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE approval_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_request_id uuid NOT NULL REFERENCES approval_requests(id),
  approver_id uuid NOT NULL,
  payload_hash text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (approval_request_id, approver_id)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  actor_id uuid,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  payload_hash text NOT NULL,
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  topic text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('pending', 'processing', 'delivered', 'failed')) DEFAULT 'pending',
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_organisation_occurred_idx ON audit_events (organisation_id, occurred_at DESC);
CREATE INDEX outbox_events_pending_idx ON outbox_events (status, created_at) WHERE status IN ('pending', 'failed');

-- Append-only enforcement is deliberately in the database, not only application code.
CREATE FUNCTION reject_audit_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();
