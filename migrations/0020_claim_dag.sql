-- Claim dependency DAG + stale propagation (control P4). Facts (numbers/observations pulled from a
-- source) FEED claims (the narrative statements the desk publishes). When a fact is corrected or
-- retracted, every claim that CONSUMES it is flipped 'stale'; a routine next-period filing that merely
-- reports the next quarter must NOT flag prior facts (only a same-period restatement beyond tolerance,
-- or a vanished fact, corrects a prior number).
--
-- All three tables are MUTABLE working state (status flips as corrections land) so they live OUTSIDE
-- the append-only canonical_snapshots (forbid_mutation trigger), keyed per snapshot/company — exactly
-- like thesis_approvals (0009) and areas_of_interest (0012). FKs cascade with snapshot/company; the
-- source pointer NULLs on delete per the 0018 cascade convention.
CREATE TABLE IF NOT EXISTS claim_facts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id      uuid NOT NULL REFERENCES canonical_snapshots(snapshot_id) ON DELETE CASCADE,
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fact_key         text NOT NULL,
  kind             text,
  source_ref       uuid REFERENCES sources(id) ON DELETE SET NULL,
  value_num        numeric,
  value_text       text,
  period           text,
  status           text DEFAULT 'active',
  superseded_by    uuid,
  correction_reason text,
  corrected_at     timestamptz,
  created_at       timestamptz DEFAULT now(),
  UNIQUE (snapshot_id, fact_key)
);
CREATE INDEX IF NOT EXISTS claim_facts_company_key_idx ON claim_facts(company_id, fact_key);

CREATE TABLE IF NOT EXISTS claims (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id  uuid NOT NULL REFERENCES canonical_snapshots(snapshot_id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  claim_kind   text,
  ordinal      int,
  text         text,
  status       text DEFAULT 'fresh',
  stale_reason text,
  stale_at     timestamptz,
  created_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS claims_snapshot_status_idx ON claims(snapshot_id, status);

CREATE TABLE IF NOT EXISTS claim_fact_edges (
  claim_id  uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  fact_id   uuid NOT NULL REFERENCES claim_facts(id) ON DELETE CASCADE,
  relation  text DEFAULT 'consumes',
  PRIMARY KEY (claim_id, fact_id)
);
CREATE INDEX IF NOT EXISTS claim_fact_edges_fact_idx ON claim_fact_edges(fact_id);
