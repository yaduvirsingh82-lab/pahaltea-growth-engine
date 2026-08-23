-- Phase 5: AI content generation provenance and structured Instagram drafts.
-- No publishing capability is added. Drafts are reviewable records only.

CREATE TABLE generation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  provider text NOT NULL,
  model text NOT NULL,
  -- True only for the deterministic offline provider used in tests and local
  -- development. Nothing generated this way may be presented as model output.
  is_offline_stub boolean NOT NULL DEFAULT false,
  prompt_template_name text NOT NULL,
  prompt_template_version integer NOT NULL CHECK (prompt_template_version > 0),
  -- Hash of the exact approved-claim snapshot the model was given, so a draft
  -- can always be traced back to the product truth available at the time.
  retrieval_snapshot_hash text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  error text,
  usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE retrieval_snapshots (
  hash text PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  claim_ids uuid[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE content_drafts
  ADD COLUMN generation_run_id uuid REFERENCES generation_runs(id),
  ADD COLUMN concept_name text,
  ADD COLUMN format text CHECK (format IN ('feed_post', 'reel', 'story')),
  ADD COLUMN objective text,
  ADD COLUMN hook text,
  ADD COLUMN caption text,
  ADD COLUMN visual_brief text,
  ADD COLUMN cta text,
  ADD COLUMN trial_offer text,
  ADD COLUMN social_proof_angle text,
  ADD COLUMN hashtags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN rationale text,
  ADD COLUMN reviewed_by uuid,
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN review_note text,
  -- A draft may only leave review through a recorded decision.
  ADD CONSTRAINT content_drafts_review_recorded
    CHECK (status NOT IN ('approved', 'archived') OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL));

CREATE TABLE content_validation_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_draft_id uuid NOT NULL REFERENCES content_drafts(id) ON DELETE CASCADE,
  check_name text NOT NULL,
  passed boolean NOT NULL,
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_draft_id, check_name)
);

CREATE INDEX generation_runs_organisation_started_idx ON generation_runs (organisation_id, started_at DESC);
CREATE INDEX content_drafts_status_idx ON content_drafts (organisation_id, status, created_at DESC);
CREATE INDEX content_validation_failures_idx ON content_validation_results (content_draft_id) WHERE passed = false;
