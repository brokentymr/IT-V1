-- Workstream C — auto-commit + admin veto/rollback.
-- The desk auto-approves cleared research (approved_by='desk'); status lets an operator veto it,
-- and content_items.suppressed lets a bad auto-published pack be pulled from the consumer surface
-- without mutating the append-only snapshot/content rows.
ALTER TABLE thesis_approvals ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'approved'; -- approved | vetoed
ALTER TABLE content_items   ADD COLUMN IF NOT EXISTS suppressed boolean NOT NULL DEFAULT false; -- rollback flag
