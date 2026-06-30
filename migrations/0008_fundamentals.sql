-- Phase 4 (Engine 2 — Fundamental Research). The snapshot diff is a first-class asset
-- (spec §3.4, §8): the coverage pass computes the change versus the prior snapshot's model
-- and stores it alongside the immutable snapshot. Append-only still holds — diff is written
-- once, at insert, and never mutated (the canonical_snapshots_append_only trigger forbids UPDATE).
ALTER TABLE canonical_snapshots
  ADD COLUMN IF NOT EXISTS diff jsonb NOT NULL DEFAULT '{}';

-- The poll path (daily EDGAR sweep) and the webhook path both record a filing arrival keyed by
-- (source='filing', accession) in webhook_deliveries, so a filing seen by both is processed once.
-- No new table needed; this index speeds the poll's "have I already seen this accession?" check.
CREATE INDEX IF NOT EXISTS webhook_deliveries_key_idx
  ON webhook_deliveries(source, idempotency_key);
