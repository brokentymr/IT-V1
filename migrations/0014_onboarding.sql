-- Auto-on-add (level-up B). Adding an asset kicks off the whole pipeline to "build clarity"
-- automatically, stopping at the §8 human checkpoint. This table tracks each onboarding run so the
-- consumer surface can show a live "Building clarity" progress strip.
CREATE TABLE IF NOT EXISTS onboarding_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'running',   -- running | done | failed
  steps       jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{step, status: ok|skipped|failed, detail, ts}]
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS onboarding_runs_company_idx ON onboarding_runs(company_id, started_at DESC);
