-- LLM cost ledger (spec §1.2 cost discipline). Every Claude call records tokens + estimated USD;
-- the client refuses new calls once the monthly spend reaches MONTHLY_SPEND_CEILING_USD.
CREATE TABLE llm_usage (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts            timestamptz NOT NULL DEFAULT now(),
  model         text NOT NULL,
  purpose       text,
  input_tokens  int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  cost_usd      numeric(12, 6) NOT NULL DEFAULT 0
);
CREATE INDEX llm_usage_ts_idx ON llm_usage(ts);
