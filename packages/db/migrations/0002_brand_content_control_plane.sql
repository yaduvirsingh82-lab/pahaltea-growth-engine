-- Phase 3: approved product truth and non-publishing content control plane.
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, name)
);

CREATE TABLE evidence_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  source_type text NOT NULL,
  reference text NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  product_id uuid NOT NULL REFERENCES products(id),
  wording text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'evidence_submitted', 'compliance_review', 'approved', 'rejected', 'retired')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  approved_at timestamptz,
  approved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE claim_evidence_links (
  claim_id uuid NOT NULL REFERENCES claims(id),
  evidence_record_id uuid NOT NULL REFERENCES evidence_records(id),
  PRIMARY KEY (claim_id, evidence_record_id)
);

CREATE TABLE content_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  channel text NOT NULL,
  body text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'claim_validation', 'review', 'approved', 'scheduled', 'published', 'failed', 'archived')) DEFAULT 'draft',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE content_claim_citations (
  content_draft_id uuid NOT NULL REFERENCES content_drafts(id),
  claim_id uuid NOT NULL REFERENCES claims(id),
  PRIMARY KEY (content_draft_id, claim_id)
);

-- No seed data is included. Product facts require owner-reviewed evidence.
