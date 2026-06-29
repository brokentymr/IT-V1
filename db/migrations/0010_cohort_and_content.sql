-- 0010_cohort_and_content.sql
-- Sector Cohort File (3.5) produced by Engine 6, and content_items (7.2): the
-- library of every audience/production consumable produced by Engines 5/6/7
-- (catalog in 6.1).

-- cohort_reports (7.2) holding the Sector Cohort File (3.5).
CREATE TABLE cohort_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gics_level    gics_level NOT NULL,        -- scope.gics_level
  scope_value   text NOT NULL,              -- scope.value (e.g. the sub-industry name/code)
  markets       market_region[] NOT NULL DEFAULT '{}',  -- scope.markets
  as_of         date NOT NULL,
  constituents  uuid[] NOT NULL DEFAULT '{}',           -- company_id[]
  comparative   jsonb NOT NULL DEFAULT '{}',            -- valuation/margin/growth/sentiment tables
  positioning   jsonb NOT NULL DEFAULT '{}',            -- leaders, laggards, value_opportunity, divergences
  sector_thesis jsonb NOT NULL DEFAULT '{}',            -- strengths, weaknesses, where_the_opportunity_is
  provenance    jsonb NOT NULL DEFAULT '[]',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_cohort_scope ON cohort_reports (gics_level, scope_value, as_of DESC);

-- content_items (7.2): memo, sector report, podcast script, short-form pack,
-- newsletter. Rendered artifacts (HTML/PDF/MD) are stored in Spaces; this row
-- holds metadata, the structured body, and the provenance/disclosure carried in.
CREATE TABLE content_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            content_kind NOT NULL,
  status          content_status NOT NULL DEFAULT 'draft',

  -- subject: a company memo points at a company + snapshot; a sector report at
  -- a cohort. Both nullable so either kind fits one table.
  company_id      uuid REFERENCES companies (id) ON DELETE CASCADE,
  snapshot_id     uuid REFERENCES canonical_snapshots (id) ON DELETE SET NULL,
  cohort_id       uuid REFERENCES cohort_reports (id) ON DELETE SET NULL,

  title           text,
  body            jsonb NOT NULL DEFAULT '{}',    -- structured per consumable spec (6.2-6.6)
  rendered_refs   jsonb NOT NULL DEFAULT '{}',    -- { html: spaces_key, pdf: spaces_key, md: ... }
  positions_held  jsonb NOT NULL DEFAULT '[]',    -- disclosure, propagated automatically (section 8)
  provenance      jsonb NOT NULL DEFAULT '[]',

  -- human checkpoint (4.5): content is generated only post-approval.
  approved_by     text,
  approved_at     timestamptz,
  published_at    timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_content_kind ON content_items (kind);
CREATE INDEX idx_content_company ON content_items (company_id);
CREATE INDEX idx_content_cohort ON content_items (cohort_id);
CREATE INDEX idx_content_status ON content_items (status);

CREATE TRIGGER trg_content_items_updated_at
  BEFORE UPDATE ON content_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
