-- 0009_signal_events.sql
-- signal_event (3.7). Signal ingestion is a WEBHOOK PATH, not an agent (4.1):
-- it receives TradingView/pricing payloads, routes by tradingview_symbol,
-- writes a signal_event, updates the snapshot `signals` block, and may raise a
-- trigger. The raw alert JSON is preserved in payload.

CREATE TABLE signal_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  ts          timestamptz NOT NULL DEFAULT now(),
  kind        signal_kind NOT NULL,        -- price | tradingview_alert
  payload     jsonb NOT NULL DEFAULT '{}', -- raw alert JSON for TradingView (FAE, CHoCH/BOS, AVWAP, RSI, ...)
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_signal_events_company ON signal_events (company_id, ts DESC);
CREATE INDEX idx_signal_events_kind ON signal_events (kind);
