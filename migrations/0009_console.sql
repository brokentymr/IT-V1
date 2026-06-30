-- Phase 5 (operator console). Two additions behind the screens' control surface.

-- Content-pipeline enrollment (content generation itself is Phase 8; this flag is what Phase 8
-- will consume). Promoted column for fast Universe filtering; mirrored into coverage jsonb by the app.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS content_enrolled boolean NOT NULL DEFAULT false;

-- Thesis approval = the mandatory human checkpoint (spec §8). Snapshots are append-only/immutable,
-- so the approval (and any human edit of the thesis) lives in its OWN table rather than mutating the
-- snapshot. One current approval per snapshot (re-approve/edit upserts); history is not required here.
CREATE TABLE IF NOT EXISTS thesis_approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id   uuid NOT NULL REFERENCES canonical_snapshots(snapshot_id) ON DELETE CASCADE,
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  approved_by   text NOT NULL DEFAULT 'operator',
  approved_at   timestamptz NOT NULL DEFAULT now(),
  edited_thesis jsonb,                       -- the human-edited thesis, if the operator changed it
  note          text,
  UNIQUE (snapshot_id)
);
CREATE INDEX IF NOT EXISTS thesis_approvals_company_idx ON thesis_approvals(company_id, approved_at DESC);
