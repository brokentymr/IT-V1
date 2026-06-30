// Brand/Sentiment full-cycle sweep (Engine 4, Phase 7). Weekly off it-v1-sentiment.timer.
// Usage: npm run sentiment            (all monitored companies)
//        npm run sentiment -- AAPL    (specific tickers)
import { loadEnv } from "../lib/env";
import { query, closePool } from "../lib/db/pool";
import { stopBoss } from "../lib/queue/boss";
import { runSentiment } from "../lib/engines/sentiment";
import { llmSpendThisMonth } from "../lib/llm/client";

loadEnv();
const tickers = process.argv.slice(2).filter((a) => !a.startsWith("-")).map((t) => t.toUpperCase());
const MONITORED = ["in_research", "in_review", "published", "monitoring"];

try {
  const { rows } = await query<{ id: string; primary_ticker: string }>(
    tickers.length
      ? "SELECT id, primary_ticker FROM companies WHERE upper(primary_ticker) = ANY($1)"
      : "SELECT id, primary_ticker FROM companies WHERE coverage_status = ANY($1)",
    [tickers.length ? tickers : MONITORED],
  );
  const before = await llmSpendThisMonth();
  const results: unknown[] = [];
  for (const c of rows) {
    try {
      const r = await runSentiment({ companyId: c.id, trigger: "cadence" });
      results.push({ ticker: r.ticker, gap: r.gap.direction, magnitude: r.gap.magnitude, confidence: r.confidence, degraded: r.degraded.length, area_opened: r.area_opened });
    } catch (e) {
      console.error(`[sentiment] ${c.primary_ticker} failed: ${(e as Error).message}`);
    }
  }
  const after = await llmSpendThisMonth();
  console.log(JSON.stringify({ companies: rows.length, results, llm_cost_usd: Number((after - before).toFixed(4)), month_spend_usd: Number(after.toFixed(4)) }, null, 2));
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await stopBoss().catch(() => {});
  await closePool();
}
