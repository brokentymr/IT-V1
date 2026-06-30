import type { PoolClient } from "pg";

/** Resolve an inbound webhook to a company in the universe, by ticker / CIK / TradingView symbol. */
export async function resolveCompanyId(
  client: PoolClient,
  by: { ticker?: string | null; symbol?: string | null; cik?: string | null },
): Promise<string | null> {
  if (by.ticker) {
    const r = await client.query<{ id: string }>(
      "SELECT id FROM companies WHERE lower(primary_ticker) = lower($1) LIMIT 1",
      [by.ticker],
    );
    if (r.rows[0]) return r.rows[0].id;
  }
  if (by.cik) {
    const cik = String(by.cik).replace(/\D/g, "").padStart(10, "0");
    const r = await client.query<{ id: string }>("SELECT id FROM companies WHERE cik = $1 LIMIT 1", [cik]);
    if (r.rows[0]) return r.rows[0].id;
  }
  if (by.symbol) {
    const r = await client.query<{ id: string }>(
      "SELECT id FROM companies WHERE tradingview_symbol = $1 LIMIT 1",
      [by.symbol],
    );
    if (r.rows[0]) return r.rows[0].id;
    const derived = by.symbol.includes(":") ? by.symbol.split(":")[1] : by.symbol;
    const r2 = await client.query<{ id: string }>(
      "SELECT id FROM companies WHERE lower(primary_ticker) = lower($1) LIMIT 1",
      [derived],
    );
    if (r2.rows[0]) return r2.rows[0].id;
  }
  return null;
}
