-- 0002_enums.sql
-- Authoritative enums from section 3 of the spec. Domains/enums are declared
-- once and reused so every table reads/writes the exact shapes the agents do.
--
-- NOTE: the importance rubric BANDS (low/material/major) and their score
-- thresholds are intentionally NOT enums — they are configuration (section 4.3),
-- tunable without a rebuild. The stored value is the raw 0-100 integer; the band
-- is derived at read time from config. See src/config/rubric.ts.

-- Market (3.2)
CREATE TYPE market_region AS ENUM ('NA', 'EMEA', 'APAC', 'LATAM');
CREATE TYPE filing_system AS ENUM ('SEC_EDGAR', 'UK_NSM', 'EDINET', 'OTHER');

-- Company coverage (3.3)
CREATE TYPE coverage_status AS ENUM (
  'watchlist', 'queued', 'in_research', 'in_review', 'published', 'monitoring'
);

-- Canonical snapshot trigger (3.4)
CREATE TYPE snapshot_trigger AS ENUM ('filing', 'manual');

-- News note (3.6)
CREATE TYPE news_category AS ENUM (
  'guidance', 'product', 'management', 'legal_regulatory',
  'macro', 'm_and_a', 'capital_markets', 'other'
);
CREATE TYPE note_origin_kind AS ENUM ('primary', 'read_through');
CREATE TYPE thesis_effect AS ENUM ('supports', 'pressures', 'neutral', 'invalidates');
CREATE TYPE magnitude AS ENUM ('low', 'medium', 'high');
CREATE TYPE note_status AS ENUM ('logged', 'flagged', 'escalated');

-- Raw documents (3.7)
CREATE TYPE raw_document_kind AS ENUM ('filing', 'transcript', 'research', 'news', 'other');

-- Signal events (3.7)
CREATE TYPE signal_kind AS ENUM ('price', 'tradingview_alert');

-- Company links (3.8)
CREATE TYPE link_type AS ENUM (
  'competitor', 'supplier', 'customer', 'parent', 'subsidiary',
  'jv_partner', 'shared_end_market', 'thematic_peer', 'macro_correlated'
);
CREATE TYPE link_strength AS ENUM ('weak', 'medium', 'strong');
CREATE TYPE link_status AS ENUM ('active', 'stale', 'unverified');

-- GICS level, used as the scope unit for cohort files (3.1, 3.5)
CREATE TYPE gics_level AS ENUM ('sector', 'industry_group', 'industry', 'sub_industry');

-- Content artifacts produced by Engines 5/6/7 (6.1)
CREATE TYPE content_kind AS ENUM (
  'company_memo', 'sector_report', 'podcast_script', 'shortform_pack', 'newsletter'
);
CREATE TYPE content_status AS ENUM ('draft', 'approved', 'published');
