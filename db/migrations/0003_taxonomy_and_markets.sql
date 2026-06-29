-- 0003_taxonomy_and_markets.sql
-- GICS sector taxonomy (3.1) and markets (3.2).
--
-- Storage is a faceted graph; sector and market are FACETS of the atomic
-- company node, not a containing hierarchy. These tables are reference data:
-- the full GICS path is denormalized onto each company (3.3) so a cohort can
-- span markets and read-through can travel across sectors.

-- GICS reference: Sector (11) -> Industry Group (25) -> Industry (74) -> Sub-Industry (163).
-- Self-referential so the four levels live in one table; `level` tags each row.
CREATE TABLE gics_classifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL,             -- GICS numeric code
  name        text NOT NULL,
  level       gics_level NOT NULL,
  parent_id   uuid REFERENCES gics_classifications (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, level)
);
CREATE INDEX idx_gics_parent ON gics_classifications (parent_id);
CREATE INDEX idx_gics_level ON gics_classifications (level);

CREATE TABLE markets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange              text NOT NULL,            -- NYSE, NASDAQ, LSE, TSE, HKEX
  country               text NOT NULL,            -- US, UK, JP
  region                market_region NOT NULL,   -- NA | EMEA | APAC | LATAM
  currency              text NOT NULL,            -- USD, GBP, JPY
  calendar_ref          text,                     -- exchange + earnings calendar
  primary_filing_system filing_system NOT NULL DEFAULT 'OTHER',
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exchange)
);
