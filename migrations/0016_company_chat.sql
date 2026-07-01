-- Workstream C — per-report chat. Grounded Q&A over a company's canonical research, plus the
-- "Deepen research now" trigger. Turns are persisted so the transcript survives reload; `action`
-- records the classified intent + any research_focus / enqueued job for the deepen path.
CREATE TABLE IF NOT EXISTS company_chats (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  snapshot_id uuid REFERENCES canonical_snapshots(snapshot_id) ON DELETE SET NULL,
  role        text NOT NULL,                       -- 'user' | 'assistant'
  message     text NOT NULL,
  action      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {intent, research_focus[], enqueued_job_id?}
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS company_chats_company_idx ON company_chats(company_id, created_at DESC);
