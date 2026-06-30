-- Reliability hardening: the analyst desk emits a confidence score (spec §8). Promoted onto the
-- snapshot so the Universe/Company screens can flag low-confidence research for the human checkpoint.
ALTER TABLE canonical_snapshots ADD COLUMN IF NOT EXISTS confidence numeric;
CREATE INDEX IF NOT EXISTS canonical_snapshots_confidence_idx ON canonical_snapshots(confidence);
