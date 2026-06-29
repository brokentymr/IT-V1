-- 0005_company_links.sql
-- Company relationship (3.8). The directed, typed edges that make coverage
-- RELATIONAL. Read-through analysis (4.3, 4.6) traverses these edges.
-- Seeded by Ingestion, enriched by Fundamental Research (suppliers/customers/
-- concentrations read out of filings), curated by hand.

CREATE TABLE company_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,  -- source asset
  to_company_id   uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,  -- asset that may be affected
  type            link_type NOT NULL,
  cross_sector    boolean NOT NULL DEFAULT false,   -- true if the two sit in different GICS sectors
  strength        link_strength NOT NULL DEFAULT 'medium',
  direction_note  text,                             -- how impact tends to flow
  rationale       text,
  source_ref      uuid REFERENCES sources (id),     -- provenance (sources defined in 0010)
  status          link_status NOT NULL DEFAULT 'unverified',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- a directed edge of a given type is unique between two companies
  UNIQUE (from_company_id, to_company_id, type),
  CHECK (from_company_id <> to_company_id)
);

CREATE INDEX idx_links_from ON company_links (from_company_id);
CREATE INDEX idx_links_to ON company_links (to_company_id);
CREATE INDEX idx_links_type ON company_links (type);
CREATE INDEX idx_links_status ON company_links (status);

CREATE TRIGGER trg_company_links_updated_at
  BEFORE UPDATE ON company_links
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
