// Run the daily News & Events Monitor (Engine 3) over the covered universe.
// Usage: npm run monitor            (all monitored companies)
//        npm run monitor -- AAPL    (specific tickers)
import { loadEnv } from "../lib/env";
import { query, closePool } from "../lib/db/pool";
import { stopBoss } from "../lib/queue/boss";
import { runDailyMonitor } from "../lib/engines/news_monitor";
import { ClaudeNewsAnalyzer } from "../lib/engines/analyzer";
import { llmSpendThisMonth } from "../lib/llm/client";

loadEnv();
const tickers = process.argv.slice(2).filter((a) => !a.startsWith("-")).map((t) => t.toUpperCase());

try {
  let companyIds: string[] | undefined;
  if (tickers.length) {
    const { rows } = await query<{ id: string }>(
      "SELECT id FROM companies WHERE upper(primary_ticker) = ANY($1)",
      [tickers],
    );
    companyIds = rows.map((r) => r.id);
  }
  const before = await llmSpendThisMonth();
  const r = await runDailyMonitor({ analyzer: new ClaudeNewsAnalyzer(), companyIds });
  const after = await llmSpendThisMonth();
  console.log(JSON.stringify({ ...r, llm_cost_usd: Number((after - before).toFixed(4)), month_spend_usd: Number(after.toFixed(4)) }, null, 2));
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await stopBoss().catch(() => {});
  await closePool();
}
