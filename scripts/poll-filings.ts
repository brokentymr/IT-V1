// Daily EDGAR poll (Engine 2 trigger). For each covered company, enqueue a coverage pass for any
// newly-filed covered form. Runs as it-v1-filings.timer.
// Usage: npm run poll-filings            (all covered companies)
//        npm run poll-filings -- AAPL    (specific tickers)
import { loadEnv } from "../lib/env";
import { query, closePool } from "../lib/db/pool";
import { stopBoss } from "../lib/queue/boss";
import { runFilingPoll } from "../lib/engines/filing_poll";

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
  const r = await runFilingPoll({ companyIds });
  console.log(JSON.stringify(r, null, 2));
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await stopBoss().catch(() => {});
  await closePool();
}
