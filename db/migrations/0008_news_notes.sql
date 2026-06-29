-- 0008_news_notes.sql
-- News Note (3.6): the rolling current-events record, written continuously by
-- Engine 3 (daily, 4.3). Two origins: `primary` (event on this asset) and
-- `read_through` (event traveled here from another asset along a company_link).
--
-- Read-through is what makes coverage relational (4.6): when a material event
-- hits asset A, a read_through note is written on each materially-affected
-- neighbour B, referencing the originating note and the link it traveled.

CREATE TABLE news_notes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,  -- the asset this note is ABOUT
  detected_at         timestamptz NOT NULL DEFAULT now(),
  source_ref          uuid REFERENCES sources (id),         -- provenance to Tier 1
  headline            text NOT NULL,
  summary             text,                                  -- plain language
  category            news_category NOT NULL DEFAULT 'other',

  -- origin: how this note came to exist (3.6)
  origin_kind         note_origin_kind NOT NULL DEFAULT 'primary',
  origin_event_ref    uuid REFERENCES news_notes (id),       -- if read_through: originating note on another asset
  origin_company_id   uuid REFERENCES companies (id),        -- if read_through: the asset the event happened to
  link_type           link_type,                             -- the relationship edge it traveled

  -- importance: raw 0-100 score; the band (low/material/major) is derived from
  -- config (src/config/rubric.ts), not stored, so thresholds stay tunable (4.3).
  importance_score    int NOT NULL CHECK (importance_score BETWEEN 0 AND 100),
  importance_rationale text,

  -- impact_analysis (3.6)
  forward_outlook         text,
  thesis_effect           thesis_effect,
  invalidation_trigger_hit text,
  sentiment_effect        text,
  estimated_magnitude     magnitude,

  -- outbound read-throughs raised FROM this note:
  -- [ {affected_company_id, link_type, expected_effect, materiality} ]
  read_through        jsonb NOT NULL DEFAULT '[]',

  status              note_status NOT NULL DEFAULT 'logged',

  -- escalation: { triggered, type, window_days, job_ref }
  escalation          jsonb NOT NULL DEFAULT '{"triggered": false}',

  -- context handed to the next full cycle (3.6)
  carried_into        uuid REFERENCES canonical_snapshots (id),

  created_at          timestamptz NOT NULL DEFAULT now(),

  -- read_through notes must reference both their origin note and origin company
  CHECK (
    origin_kind = 'primary'
    OR (origin_event_ref IS NOT NULL AND origin_company_id IS NOT NULL)
  )
);
CREATE INDEX idx_news_notes_company ON news_notes (company_id, detected_at DESC);
CREATE INDEX idx_news_notes_status ON news_notes (status);
CREATE INDEX idx_news_notes_origin_kind ON news_notes (origin_kind);
CREATE INDEX idx_news_notes_origin_event ON news_notes (origin_event_ref);
CREATE INDEX idx_news_notes_importance ON news_notes (importance_score);
