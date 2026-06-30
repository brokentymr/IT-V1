-- Provenance, the versioned canonical file (+ append-only snapshots), and the streams
-- that feed it: news notes (primary + read-through), signal events, raw documents.

-- §8 provenance: every material claim refs a Tier-1 source row.
CREATE TABLE sources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid REFERENCES companies(id) ON DELETE CASCADE,
  tier         int NOT NULL DEFAULT 1,
  kind         text NOT NULL,                 -- filing | transcript | research | news | pricing | tradingview_alert | api | web | other
  origin       text NOT NULL,                 -- e.g. "SEC EDGAR"
  url          text,
  title        text,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  blob_ref     text,                          -- object-storage key if archived
  metadata     jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX sources_company_idx ON sources(company_id);

-- §3.4 canonical company file: one per company. current_events is maintained daily (mutable);
-- the immutable per-cycle snapshots live in canonical_snapshots.
CREATE TABLE canonical_files (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  current_events jsonb NOT NULL DEFAULT '{"rolling_outlook":"","notes":[]}',  -- §3.4 current_events
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER canonical_files_touch BEFORE UPDATE ON canonical_files
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Append-only snapshots. Promoted columns per locked decision #3; full §3.4 body in `content`.
CREATE TABLE canonical_snapshots (
  snapshot_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_file_id uuid NOT NULL REFERENCES canonical_files(id) ON DELETE CASCADE,
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  as_of            date NOT NULL,
  cycle_label      text NOT NULL,
  trigger          text NOT NULL CHECK (trigger IN ('filing', 'manual')),
  conviction       int CHECK (conviction BETWEEN 1 AND 5),
  filing_ref       text,
  content          jsonb NOT NULL DEFAULT '{}',   -- §3.4 snapshot body (fundamentals/brand_sentiment/signals/thesis/events)
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX canonical_snapshots_company_asof_idx ON canonical_snapshots(company_id, as_of DESC);
-- Enforce append-only (spec §8): re-runs append; prior snapshots never mutate.
CREATE TRIGGER canonical_snapshots_append_only BEFORE UPDATE OR DELETE ON canonical_snapshots
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- §3.6 news notes (primary + read_through). Promoted columns for the daily monitor + feeds.
CREATE TABLE news_notes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,  -- the asset this note is ABOUT
  detected_at      timestamptz NOT NULL DEFAULT now(),
  source_ref       uuid REFERENCES sources(id),
  category         text NOT NULL,
  origin_kind      text NOT NULL CHECK (origin_kind IN ('primary', 'read_through')),
  origin_company_id uuid REFERENCES companies(id) ON DELETE SET NULL,         -- if read_through: where the event happened
  importance_score int NOT NULL CHECK (importance_score BETWEEN 0 AND 100),
  status           text NOT NULL CHECK (status IN ('logged', 'flagged', 'escalated')),
  content          jsonb NOT NULL,                                            -- full §3.6 note
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX news_notes_company_detected_idx ON news_notes(company_id, detected_at DESC);
CREATE INDEX news_notes_status_idx ON news_notes(status);
CREATE INDEX news_notes_origin_kind_idx ON news_notes(origin_kind);

-- §3.7 signal events (webhook-ingested pricing / TradingView alerts).
CREATE TABLE signal_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  ts         timestamptz NOT NULL DEFAULT now(),
  kind       text NOT NULL CHECK (kind IN ('price', 'tradingview_alert')),
  payload    jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX signal_events_company_ts_idx ON signal_events(company_id, ts DESC);

-- §3.7 raw documents (metadata; bytes live in Spaces under blob_ref).
CREATE TABLE raw_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('filing', 'transcript', 'research', 'news', 'other')),
  received_at timestamptz NOT NULL DEFAULT now(),
  source      text NOT NULL,
  blob_ref    text NOT NULL,
  metadata    jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX raw_documents_company_idx ON raw_documents(company_id);
