-- Read-through relationships (control P12). enrichLinks only ever created company_links to
-- counterparties ALREADY in our universe; every named customer/supplier/partner that we do NOT cover
-- was dropped on the floor (`if (!to) continue`), so the relationship graph rendered empty for most
-- names. This table captures those UNCOVERED counterparties (plus the demand-side customers extracted
-- from the filing) as first-class read-through edges the reader surface can render.
--
-- Mutable (latest coverage wins via the upsert) and keyed by company + snapshot, so it lives in its OWN
-- table kept SEPARATE from the append-only canonical_snapshots — exactly like thesis_approvals (0009)
-- and areas_of_interest (0012). A covered counterparty stays in company_links; when one later becomes
-- covered its to_company_id is populated here so the two views reconcile.
CREATE TABLE IF NOT EXISTS read_through_relationships (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  snapshot_id       uuid REFERENCES canonical_snapshots(snapshot_id) ON DELETE CASCADE,
  counterparty_name text NOT NULL,
  ticker            text,
  type              text,                                         -- reuses the LinkType vocabulary (customer/supplier/…)
  materiality       text,                                         -- low | medium | high
  rationale         text,
  read_through      text,                                         -- what the filing implies for this counterparty
  to_company_id     uuid REFERENCES companies(id) ON DELETE SET NULL, -- populated when the counterparty is covered
  source_ref        uuid REFERENCES sources(id) ON DELETE SET NULL,   -- the filing this was read out of (nullable)
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- At most one row per company + counterparty + type: repeated coverage passes upsert onto it (latest
-- snapshot_id/source_ref wins). Uses lower(counterparty_name) so casing never splits the edge.
CREATE UNIQUE INDEX IF NOT EXISTS read_through_relationships_uniq
  ON read_through_relationships(company_id, lower(counterparty_name), type);
CREATE INDEX IF NOT EXISTS read_through_relationships_company_idx ON read_through_relationships(company_id);
