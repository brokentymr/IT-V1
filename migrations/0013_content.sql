-- Content layer (Phase 8). content_items already exists (0004 foundation) with id/company_id/cohort_id/
-- type/format/audience/body/metadata/created_at. Extend it for the Phase 8 consumables: the Company
-- Deck (visual atom), the newsletter (embeds deck slides), the short-form pack (reductions), and the
-- podcast episode (built from both hosts' notes). A rendered artifact (PDF/MD) may also land in Spaces.
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS snapshot_id uuid REFERENCES canonical_snapshots(snapshot_id) ON DELETE SET NULL;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS title      text;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS provenance jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS disclosure text;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS blob_ref   text;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS status     text NOT NULL DEFAULT 'draft';
CREATE INDEX IF NOT EXISTS content_items_company_type_idx ON content_items(company_id, type, created_at DESC);

-- The podcast studio: each host (owner + partner) attaches their own notes to a company's research;
-- "build episode" weaves both note-sets + the substance into the §6.4 script, attributed by author.
CREATE TABLE IF NOT EXISTS episode_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  author      text NOT NULL,                          -- host name / handle
  note        text NOT NULL,
  used_in     uuid REFERENCES content_items(id) ON DELETE SET NULL, -- the episode it was woven into, once built
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS episode_notes_company_idx ON episode_notes(company_id, created_at);

-- The plain-language layer's running glossary (spec §5): grows as terms are explained, reused across
-- consumables so the house voice stays consistent.
CREATE TABLE IF NOT EXISTS content_glossary (
  term            text PRIMARY KEY,
  plain_definition text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
