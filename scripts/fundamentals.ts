// Run Engine 2 (Fundamental Research) manually for a ticker.
// Usage:
//   npm run fundamentals -- AAPL --forward [--force]         (stage the forward note)
//   npm run fundamentals -- AAPL --coverage [--accession N] [--form 10-Q]
// Coverage with no --accession picks the company's latest covered filing from EDGAR.
import { loadEnv } from "../lib/env";
import { query, closePool } from "../lib/db/pool";
import { stopBoss } from "../lib/queue/boss";
import { SecAdapter, liveJsonFetcher } from "../lib/sources/sec";
import { NasdaqEarningsAdapter } from "../lib/sources/earnings";
import { PerplexityFinance } from "../lib/sources/perplexity";
import { ClaudeFundamentalsAnalyst } from "../lib/engines/fundamentals_analyst";
import { ClaudeNewsAnalyzer } from "../lib/engines/analyzer";
import { runForwardPass, runCoveragePass } from "../lib/engines/fundamental_research";
import { FUNDAMENTALS_CONFIG } from "../lib/config/fundamentals";
import { llmSpendThisMonth } from "../lib/llm/client";

loadEnv();
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const ticker = args.find((a) => !a.startsWith("--") && a !== opt("accession") && a !== opt("form"))?.toUpperCase();

try {
  if (!ticker) throw new Error("usage: npm run fundamentals -- <TICKER> --forward|--coverage");
  const { rows } = await query<{ id: string; cik: string | null }>(
    "SELECT id, cik FROM companies WHERE upper(primary_ticker) = $1", [ticker],
  );
  const company = rows[0];
  if (!company) throw new Error(`ticker ${ticker} is not a covered company (ingest it first)`);

  const sec = new SecAdapter();
  const analyst = new ClaudeFundamentalsAnalyst();
  const finance = new PerplexityFinance();
  const before = await llmSpendThisMonth();
  let out: unknown;

  if (flag("forward")) {
    out = await runForwardPass({
      companyId: company.id, analyst, sec, finance,
      nasdaq: new NasdaqEarningsAdapter(liveJsonFetcher), force: flag("force"),
    });
  } else {
    // default + --coverage
    let accession = opt("accession");
    let form = opt("form") ?? null;
    let filingUrl: string | null = null;
    if (!accession) {
      if (!company.cik) throw new Error(`${ticker} has no CIK`);
      const filings = await sec.recentFilings(company.cik, { forms: FUNDAMENTALS_CONFIG.triggerForms });
      const latest = filings.data?.[0];
      if (!latest) throw new Error(`no covered filings found for ${ticker}`);
      accession = latest.accession; form = latest.form; filingUrl = latest.url;
      console.error(`[fundamentals] latest filing: ${form} ${accession}`);
    }
    out = await runCoveragePass({
      companyId: company.id, accession, formType: form, filingUrl,
      analyst, newsAnalyzer: new ClaudeNewsAnalyzer(), finance, sec, trigger: "manual",
    });
  }

  const after = await llmSpendThisMonth();
  console.log(JSON.stringify({ ...(out as object), llm_cost_usd: Number((after - before).toFixed(4)), month_spend_usd: Number(after.toFixed(4)) }, null, 2));
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await stopBoss().catch(() => {});
  await closePool();
}
