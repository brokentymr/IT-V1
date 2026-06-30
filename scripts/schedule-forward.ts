// Forward-pass scheduler (Phase 6): stage forward passes for covered listed names whose next
// earnings date is inside the T-minus lead window. Runs daily off it-v1-forward.timer.
// Usage: npm run schedule-forward            (all monitored listed companies)
//        npm run schedule-forward -- AAPL    (specific tickers)
import { loadEnv } from "../lib/env";
import { query, closePool } from "../lib/db/pool";
import { stopBoss } from "../lib/queue/boss";
import { SecAdapter, liveJsonFetcher } from "../lib/sources/sec";
import { NasdaqEarningsAdapter } from "../lib/sources/earnings";
import { PerplexityFinance } from "../lib/sources/perplexity";
import { ClaudeFundamentalsAnalyst } from "../lib/engines/fundamentals_analyst";
import { runForwardScheduler } from "../lib/engines/scheduler";
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
  const r = await runForwardScheduler({
    analyst: new ClaudeFundamentalsAnalyst(),
    sec: new SecAdapter(),
    nasdaq: new NasdaqEarningsAdapter(liveJsonFetcher),
    finance: new PerplexityFinance(),
    companyIds,
  });
  const after = await llmSpendThisMonth();
  console.log(JSON.stringify({ ...r, llm_cost_usd: Number((after - before).toFixed(4)), month_spend_usd: Number(after.toFixed(4)) }, null, 2));
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await stopBoss().catch(() => {});
  await closePool();
}
