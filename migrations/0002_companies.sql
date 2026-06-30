-- §3.3 company index record + §3.8 relationship graph.
-- Hybrid storage (locked decision #3): nested sub-objects as JSONB, queryable fields promoted.

CREATE TABLE companies (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name         text NOT NULL,
  primary_ticker     text,
  cik                text,
  identifiers        jsonb NOT NULL,                 -- §3.3 identifiers {legal_name, tickers[], isin, cik, lei}
  classification     jsonb NOT NULL,                 -- §3.1 {gics_sector, industry_group, industry, sub_industry}
  markets            jsonb NOT NULL DEFAULT '[]',    -- [§3.2 market]
  tradingview_symbol text,
  coverage           jsonb NOT NULL,                 -- §3.3 coverage {status, authors[], next_earnings_date, positions_held[]}
  -- promoted/queryable (kept in sync by the data layer):
  coverage_status    text NOT NULL,
  gics_sector        text,
  sub_industry       text,                            -- cohort unit
  next_earnings_date date,
  classification_confidence numeric,                  -- 0..1; low when sub-industry is best-effort (Phase 1 SEC/SIC)
  canonical_file_ref uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- One company per ticker (case-insensitive) — Ingestion is idempotent on re-add.
CREATE UNIQUE INDEX companies_primary_ticker_uniq ON companies (lower(primary_ticker)) WHERE primary_ticker IS NOT NULL;
CREATE INDEX companies_cik_idx ON companies(cik);
CREATE INDEX companies_coverage_status_idx ON companies(coverage_status);
CREATE INDEX companies_sub_industry_idx ON companies(sub_industry);
CREATE INDEX companies_next_earnings_idx ON companies(next_earnings_date);
-- search across all tickers held in identifiers.tickers[]
CREATE INDEX companies_tickers_gin ON companies USING gin ((identifiers -> 'tickers'));

CREATE TRIGGER companies_touch BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- §3.8 directed, typed relationship edges (the read-through graph).
CREATE TABLE company_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  to_company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN (
                    'competitor', 'supplier', 'customer', 'parent', 'subsidiary',
                    'jv_partner', 'shared_end_market', 'thematic_peer', 'macro_correlated')),
  cross_sector    boolean NOT NULL DEFAULT false,
  strength        text NOT NULL CHECK (strength IN ('weak', 'medium', 'strong')),
  direction_note  text,
  rationale       text,
  source_ref      uuid,
  status          text NOT NULL DEFAULT 'unverified' CHECK (status IN ('active', 'stale', 'unverified')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (from_company_id <> to_company_id)
);
-- one edge of a given type between the same ordered pair
CREATE UNIQUE INDEX company_links_uniq ON company_links (from_company_id, to_company_id, type);
CREATE INDEX company_links_from_idx ON company_links(from_company_id);
CREATE INDEX company_links_to_idx ON company_links(to_company_id);
