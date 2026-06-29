-- 0007_canonical_files.sql
-- Canonical Company File (3.4). The owned, versioned object that every output
-- transforms. ONE substrate, many adapters: research is performed once per
-- company per cycle and stored here; no output performs its own research.
--
-- Shape: one canonical_files row per company holds the daily-maintained
-- current_events block (JSONB); snapshots are append-only child rows so the
-- diff between snapshots is a first-class asset (section 8, versioning).

CREATE TABLE canonical_files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL UNIQUE REFERENCES companies (id) ON DELETE CASCADE,

  -- current_events (3.4): maintained DAILY by Engine 3 and rolled forward.
  --   { rolling_outlook, last_monitored, notes: [news_note refs] }
  -- The authoritative news_note rows live in 0008; this block carries the
  -- maintained forward view + last_monitored marker.
  current_events  jsonb NOT NULL DEFAULT '{"rolling_outlook": null, "last_monitored": null}',

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_canonical_files_company ON canonical_files (company_id);

CREATE TRIGGER trg_canonical_files_updated_at
  BEFORE UPDATE ON canonical_files
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Append-only snapshots (3.4). Each cycle appends one; jobs are idempotent —
-- a re-run appends a new snapshot and never corrupts a prior one (4.5).
-- The heavy engine output (fundamentals, brand_sentiment, signals, thesis,
-- events) is stored as JSONB exactly per the 3.4 sub-schemas; queryable fields
-- (as_of, cycle_label, trigger, conviction) are promoted to columns.
CREATE TABLE canonical_snapshots (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  as_of          date NOT NULL,
  cycle_label    text,                              -- e.g. "post-10Q-2026Q2"
  trigger        snapshot_trigger NOT NULL,         -- filing | manual
  filing_ref     uuid REFERENCES raw_documents (id),-- the filing that triggered this snapshot

  fundamentals   jsonb NOT NULL DEFAULT '{}',       -- ENGINE 2: statements, capital_structure, model, provenance
  brand_sentiment jsonb NOT NULL DEFAULT '{}',      -- ENGINE 4: by_platform, ground_momentum, gap, window
  signals        jsonb NOT NULL DEFAULT '{}',       -- signal ingest: pricing, tradingview_alerts, technical_context
  thesis         jsonb NOT NULL DEFAULT '{}',       -- synthesis: one_liner, long_form, tensions, catalysts, ...
  events         jsonb NOT NULL DEFAULT '{}',       -- earnings, filings

  conviction     int CHECK (conviction BETWEEN 1 AND 5),  -- promoted from thesis.conviction
  confidence     numeric,                           -- engine confidence score (section 8 reliability)
  missing_sources jsonb NOT NULL DEFAULT '[]',      -- section 8: missing-sources list

  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_snapshots_company ON canonical_snapshots (company_id);
CREATE INDEX idx_snapshots_as_of ON canonical_snapshots (company_id, as_of DESC);
CREATE INDEX idx_snapshots_trigger ON canonical_snapshots (trigger);
