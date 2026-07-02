-- Provenance foundation (control P3): every material number is a CLAIM with a locator, and any
-- unverified currency figure in a free-text invalidation trigger is QUARANTINED (never auto-published).
--
-- The extracted claims are MUTABLE working state (verified toggles as extraction confidence resolves)
-- and are keyed per snapshot/company — so they live in their OWN table, kept SEPARATE from the
-- append-only canonical_snapshots (forbid_mutation trigger), exactly like thesis_approvals (0009) and
-- areas_of_interest (0012). FKs cascade with the snapshot/company; the source pointer NULLs on delete
-- per the 0018 cascade convention.
CREATE TABLE IF NOT EXISTS numeric_claims (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id           uuid NOT NULL REFERENCES canonical_snapshots(snapshot_id) ON DELETE CASCADE,
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_ref            uuid REFERENCES sources(id) ON DELETE SET NULL,
  value                 numeric,
  unit                  text,
  period                text,
  source_doc            text,
  source_locator        text,
  extraction_confidence numeric DEFAULT 0,
  verified              boolean DEFAULT false,
  created_at            timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS numeric_claims_company_idx  ON numeric_claims(company_id);
CREATE INDEX IF NOT EXISTS numeric_claims_snapshot_idx ON numeric_claims(snapshot_id);
