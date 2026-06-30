// Price-anomaly salience monitor (Phase 6): pull daily bars for covered listed names, and on an
// abnormal move open + attribute a price_action area of interest. Runs daily off it-v1-prices.timer.
// Usage: npm run price-monitor            (all monitored listed companies)
//        npm run price-monitor -- AAPL    (specific tickers)
import { loadEnv } from "../lib/env";
import { query, closePool } from "../lib/db/pool";
import { stopBoss } from "../lib/queue/boss";
import { PriceAdapter } from "../lib/sources/prices";
import { ClaudePriceAttributor } from "../lib/engines/price_attribution";
import { runPriceMonitor } from "../lib/engines/price_monitor";
import { llmSpendThisMonth } from "../lib/llm/client";

loadEnv();
const tickers = process.argv.slice(2).filter((a) => !a.startsWith("-")).map((t) => t.toUpperCase());

try {
  let companyIds: string[] | undefined;
  if (tickers.length) {
    const { rows } = await query<{ id: string }>(
      "SELECT id FROM companies WHERE upper(primary_ticker) = ANY($1)", [tickers],
    );
    companyIds = rows.map((r) => r.id);
  }
  const before = await llmSpendThisMonth();
  const r = await runPriceMonitor({ prices: new PriceAdapter(), attributor: new ClaudePriceAttributor(), companyIds });
  const after = await llmSpendThisMonth();
  console.log(JSON.stringify({ ...r, llm_cost_usd: Number((after - before).toFixed(4)), month_spend_usd: Number(after.toFixed(4)) }, null, 2));
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await stopBoss().catch(() => {});
  await closePool();
}
