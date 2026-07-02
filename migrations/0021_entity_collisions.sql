-- Entity-gate enforcement + collision audit log (control P8). Short/ambiguous tickers (MU → Micron vs.
-- the letters "mu"; GM → General Motors vs. "GM crops"; F → Ford vs. the grade) generate false-positive
-- news matches. When the entity gate REJECTS a headline for a collision-prone ticker we record the
-- offending phrase here so operators can audit the false positives and grow the per-ticker denylist.
--
-- Mutable working state (hit counts accumulate as the same junk phrase recurs) → a SEPARATE table
-- OUTSIDE the append-only canonical_snapshots (forbid_mutation trigger), keyed per company exactly like
-- thesis_approvals (0009) / areas_of_interest (0012). The company cascades on delete; the source pointer
-- NULLs on delete per the 0018 cascade convention. UNIQUE(ticker,term) makes the upsert idempotent so a
-- recurring phrase bumps `hits`/`last_seen` rather than spawning duplicate rows.
CREATE TABLE IF NOT EXISTS ticker_collisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker      text NOT NULL,
  company_id  uuid REFERENCES companies(id) ON DELETE CASCADE,
  term        text NOT NULL,
  headline    text,
  source_ref  uuid REFERENCES sources(id) ON DELETE SET NULL,
  hits        int NOT NULL DEFAULT 1,
  first_seen  timestamptz DEFAULT now(),
  last_seen   timestamptz DEFAULT now(),
  UNIQUE (ticker, term)
);
CREATE INDEX IF NOT EXISTS ticker_collisions_ticker_idx ON ticker_collisions(ticker);
