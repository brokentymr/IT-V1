-- Areas of Interest (Phase 5.5). Between-filing material developments that the daily News Monitor
-- surfaces from the headlines accumulate here per company; the filing-triggered analyst desk then
-- ADJUDICATES the open ones and resolves the ones it can put to bed. This closes the loop the system
-- was missing: news accumulates the questions, filings auto-run the answers.
--
-- Mutable status (open → carried_forward → resolved) — so this lives in its OWN table, kept SEPARATE
-- from the append-only canonical_snapshots, exactly like thesis_approvals (migration 0009).
CREATE TABLE IF NOT EXISTS areas_of_interest (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  theme                 text NOT NULL,                       -- clustering key (news category)
  title                 text NOT NULL,                       -- latest representative headline
  summary               text,                                -- accumulated context
  category              text NOT NULL,                       -- news category at open
  band                  text NOT NULL,                       -- material | major (peak)
  score                 int  NOT NULL,                       -- peak importance score (0-100)
  mentions              int  NOT NULL DEFAULT 1,             -- notes accumulated (cluster strength)
  headlines             jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{headline,url,detected_at,score}]
  status                text NOT NULL DEFAULT 'open',        -- open | carried_forward | resolved
  disposition           text,                                -- invalidated | confirmed | overreaction | carried_forward
  resolution_note       text,                                -- the desk's one-line reasoning
  revisit_after         date,                                -- carried_forward → Phase 6 forward scheduler acts on this
  opened_at             timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  resolved_at           timestamptz,
  resolved_by_accession text,
  resolved_by_snapshot  uuid REFERENCES canonical_snapshots(snapshot_id) ON DELETE SET NULL
);

-- At most one OPEN/carried area per company+theme: repeat headlines on the same theme ACCUMULATE
-- onto it (the upsert below). Resolved areas are historical and not constrained.
CREATE UNIQUE INDEX IF NOT EXISTS areas_of_interest_open_theme_idx
  ON areas_of_interest(company_id, theme) WHERE status <> 'resolved';
CREATE INDEX IF NOT EXISTS areas_of_interest_company_idx ON areas_of_interest(company_id, status);
