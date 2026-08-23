-- Phase 6: publication attempts against an external channel.
-- Every row is an attempt record. A row existing is not permission to publish;
-- admission is decided by policy at execution time.

CREATE TABLE publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  content_draft_id uuid NOT NULL REFERENCES content_drafts(id),
  integration_connection_id uuid REFERENCES integration_connections(id),
  provider text NOT NULL CHECK (provider IN ('instagram', 'meta')),

  -- A dry run performs no external write. It is recorded so the plan that a
  -- live run would execute is auditable before anyone authorises it.
  dry_run boolean NOT NULL,

  status text NOT NULL CHECK (status IN ('planned', 'container_created', 'published', 'failed')),

  -- Binds this attempt to the approval that released this exact copy.
  approval_request_id uuid REFERENCES approval_requests(id),
  payload_hash text NOT NULL,

  -- The publicly reachable media URL handed to the provider.
  media_url text,
  media_sha256 text,

  provider_container_id text,
  provider_media_id text,
  permalink text,

  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error text,

  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,

  -- A live publication must always carry the connection it went out through.
  CHECK (dry_run = true OR integration_connection_id IS NOT NULL),
  -- A published row must carry the provider's id for reconciliation.
  CHECK (status <> 'published' OR (provider_media_id IS NOT NULL AND published_at IS NOT NULL)),
  -- A live publication must be bound to an approval.
  CHECK (dry_run = true OR approval_request_id IS NOT NULL)
);

-- At most one live publication per draft. Retries reuse the row; a second
-- successful live publish of the same draft is prevented by the database, not
-- only by application logic.
CREATE UNIQUE INDEX publications_one_live_per_draft
  ON publications (content_draft_id) WHERE dry_run = false;

CREATE INDEX publications_status_idx ON publications (organisation_id, status, created_at DESC);
