-- Phase 4: integration connection and webhook-admission persistence.
-- Credentials and raw provider payloads are intentionally not stored here.
CREATE TABLE integration_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  provider text NOT NULL CHECK (provider IN ('shopify', 'meta', 'instagram', 'n8n', 'whatsapp')),
  mode text NOT NULL CHECK (mode IN ('offline', 'sandbox', 'read_only', 'write')) DEFAULT 'offline',
  account_id text NOT NULL,
  credential_reference text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, provider, account_id),
  CHECK ((enabled = false) OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  key text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, key)
);

CREATE TABLE webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  integration_connection_id uuid REFERENCES integration_connections(id),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  payload_hash text NOT NULL,
  signature_valid boolean NOT NULL,
  admission_status text NOT NULL CHECK (admission_status IN ('accepted', 'rejected_duplicate', 'rejected_signature', 'rejected_connection', 'failed')),
  correlation_id uuid NOT NULL,
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, provider, provider_event_id)
);

CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);
CREATE INDEX webhook_events_connection_received_idx ON webhook_events (integration_connection_id, received_at DESC);
