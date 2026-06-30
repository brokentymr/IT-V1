-- Foundation: extensions, the append-only guard, GICS taxonomy, markets reference.
-- (gen_random_uuid() is core in Postgres 13+; no pgcrypto needed.)

CREATE EXTENSION IF NOT EXISTS vector;

-- Reusable guard: attach to append-only tables to block UPDATE/DELETE at the DB.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only — % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

-- updated_at touch helper.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- §3.1 GICS taxonomy. Named `sectors` per the §7.2 table list, but it holds the full
-- tree: Sector → Industry Group → Industry → Sub-Industry (sub_industry is the cohort unit).
CREATE TABLE sectors (
  code         text PRIMARY KEY,                       -- GICS code (2/4/6/8 digits)
  name         text NOT NULL,
  level        text NOT NULL CHECK (level IN ('sector', 'industry_group', 'industry', 'sub_industry')),
  parent_code  text REFERENCES sectors(code)
);
CREATE INDEX sectors_parent_idx ON sectors(parent_code);
CREATE INDEX sectors_level_idx ON sectors(level);

-- §3.2 markets reference (companies also embed a market copy in companies.markets JSONB).
CREATE TABLE markets (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange               text NOT NULL UNIQUE,
  country                text NOT NULL,
  region                 text NOT NULL CHECK (region IN ('NA', 'EMEA', 'APAC', 'LATAM')),
  currency               text NOT NULL,
  primary_filing_system  text NOT NULL,
  calendar_ref           text
);
