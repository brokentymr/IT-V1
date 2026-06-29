-- 0004_companies.sql
-- Company index record (3.3). The company is the ATOMIC NODE of the graph.
-- Sector and market are facets; relationships to other companies live in
-- company_links (0005). The canonical file (0006) holds the versioned research.

CREATE TABLE companies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- identifiers
  legal_name          text NOT NULL,
  tickers             text[] NOT NULL DEFAULT '{}',
  isin                text,
  cik                 text,
  lei                 text,

  -- classification: full GICS path (3.1) referenced for queryability;
  -- sub_industry is the cohort unit, sector the unit for sector-level pieces.
  gics_sector_id      uuid REFERENCES gics_classifications (id),
  industry_group_id   uuid REFERENCES gics_classifications (id),
  industry_id         uuid REFERENCES gics_classifications (id),
  sub_industry_id     uuid REFERENCES gics_classifications (id),

  -- alert routing (signals webhook path, 4.1)
  tradingview_symbol  text,                                  -- e.g. "NYSE:REF"

  -- coverage
  status              coverage_status NOT NULL DEFAULT 'watchlist',
  authors             text[] NOT NULL DEFAULT '{}',          -- attribution metadata only
  next_earnings_date  date,
  positions_held      jsonb NOT NULL DEFAULT '[]',           -- [ {instrument, direction, size, as_of} ]

  -- the canonical file pointer; reverse FK lives on canonical_files.company_id.
  canonical_file_ref  uuid,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_companies_status ON companies (status);
CREATE INDEX idx_companies_sub_industry ON companies (sub_industry_id);
CREATE INDEX idx_companies_sector ON companies (gics_sector_id);
CREATE INDEX idx_companies_next_earnings ON companies (next_earnings_date);
CREATE INDEX idx_companies_tickers ON companies USING gin (tickers);
CREATE INDEX idx_companies_tradingview_symbol ON companies (tradingview_symbol);

CREATE TRIGGER trg_companies_updated_at
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A company can trade on multiple markets (3.3 markets: [market]). Many-to-many.
CREATE TABLE company_markets (
  company_id  uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  market_id   uuid NOT NULL REFERENCES markets (id),
  is_primary  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (company_id, market_id)
);
CREATE INDEX idx_company_markets_market ON company_markets (market_id);
