-- Webhook delivery idempotency (Phase 2). Every inbound webhook records a delivery
-- keyed by (source, idempotency_key); a replay collides on the unique index and is
-- acknowledged without reprocessing — no double-write (spec §9.2 idempotency).
CREATE TABLE webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source          text NOT NULL,                 -- tradingview | filing
  idempotency_key text NOT NULL,
  company_id      uuid REFERENCES companies(id) ON DELETE SET NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  payload         jsonb NOT NULL DEFAULT '{}',
  result          jsonb NOT NULL DEFAULT '{}',
  UNIQUE (source, idempotency_key)
);
CREATE INDEX webhook_deliveries_source_idx ON webhook_deliveries(source, received_at DESC);
