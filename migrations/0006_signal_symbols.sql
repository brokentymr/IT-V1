-- Capture market-data signals for symbols not (yet) in the company universe — e.g. index
-- futures like NQ!. Unrouted signals are retained, not dropped (the §4.6 "nothing material is
-- silently dropped" principle, applied to market data). company_id becomes optional.
ALTER TABLE signal_events ALTER COLUMN company_id DROP NOT NULL;
ALTER TABLE signal_events ADD COLUMN symbol text;
CREATE INDEX signal_events_symbol_ts_idx ON signal_events(symbol, ts DESC);
