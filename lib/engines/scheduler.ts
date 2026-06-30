/**
 * Forward-pass scheduler (Phase 6, spec §9.6). The cadence layer that pre-stages research cycles
 * ahead of known filing dates: for every covered listed asset whose next_earnings_date falls inside
 * the T-minus lead window, stage a forward pass — once. A forward note already staged for that exact
 * date is skipped (no duplicate work / no duplicate LLM spend); a date that has MOVED no longer
 * matches, so it re-stages cleanly. Runs daily off it-v1-forward.timer.
 */
import { query } from "../db/pool";
import { SecAdapter } from "../sources/sec";
import { NasdaqEarningsAdapter } from "../sources/earnings";
import type { PerplexityFinance } from "../sources/perplexity";
import type { FundamentalsConfig } from "../config/fundamentals";
import type { FundamentalsAnalyst } from "./fundamentals_analyst";
import { runForwardPass } from "./fundamental_research";

const MONITORED_STATUSES = ["in_research", "in_review", "published", "monitoring"];

export interface SchedulerResult {
  companies: number;
  staged: number;
  skipped_existing: number;
  out_of_window: number;
  errors: number;
  details: Array<{ ticker: string; action: "staged" | "already_staged" | "out_of_window" | "error"; date: string | null; days_until: number | null }>;
}

export async function runForwardScheduler(opts: {
  analyst: FundamentalsAnalyst;
  sec?: SecAdapter;
  nasdaq?: NasdaqEarningsAdapter;
  finance?: PerplexityFinance;
  config?: FundamentalsConfig;
  today?: string;
  companyIds?: string[];
  force?: boolean;
}): Promise<SchedulerResult> {
  const sec = opts.sec ?? new SecAdapter();
  const result: SchedulerResult = { companies: 0, staged: 0, skipped_existing: 0, out_of_window: 0, errors: 0, details: [] };

  // Listed names only (a forward pass needs XBRL facts); pre-IPO/private have no earnings cadence.
  const companies = await query<{ id: string; primary_ticker: string }>(
    opts.companyIds?.length
      ? "SELECT id, primary_ticker FROM companies WHERE id = ANY($1) AND listing = 'listed'"
      : "SELECT id, primary_ticker FROM companies WHERE coverage_status = ANY($1) AND listing = 'listed'",
    [opts.companyIds?.length ? opts.companyIds : MONITORED_STATUSES],
  );

  for (const c of companies.rows) {
    result.companies++;
    try {
      const fr = await runForwardPass({
        companyId: c.id, analyst: opts.analyst, sec, nasdaq: opts.nasdaq, finance: opts.finance,
        config: opts.config, today: opts.today, force: opts.force, dedupe: true,
      });
      if (fr.wrote) {
        result.staged++;
        result.details.push({ ticker: c.primary_ticker, action: "staged", date: fr.next_earnings_date, days_until: fr.days_until });
      } else if (fr.within_window) {
        result.skipped_existing++;
        result.details.push({ ticker: c.primary_ticker, action: "already_staged", date: fr.next_earnings_date, days_until: fr.days_until });
      } else {
        result.out_of_window++;
        result.details.push({ ticker: c.primary_ticker, action: "out_of_window", date: fr.next_earnings_date, days_until: fr.days_until });
      }
    } catch (e) {
      result.errors++;
      result.details.push({ ticker: c.primary_ticker, action: "error", date: null, days_until: null });
      console.warn(`[scheduler] ${c.primary_ticker} forward pass failed: ${(e as Error).message}`);
    }
  }

  // The lead window lives in FUNDAMENTALS_CONFIG.forwardLeadDays (runForwardPass honors it).
  return result;
}
