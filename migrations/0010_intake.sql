-- Phase 5 follow-up: agentic natural-language asset intake.
-- Listing status so the Universe can hold listed, pre-IPO, and private names side by side.
-- (companies.primary_ticker / cik are already nullable, so tickerless private records are allowed.)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS listing text NOT NULL DEFAULT 'listed'
  CHECK (listing IN ('listed', 'pre_ipo', 'private'));
CREATE INDEX IF NOT EXISTS companies_listing_idx ON companies(listing);
