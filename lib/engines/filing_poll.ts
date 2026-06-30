/**
 * Daily EDGAR poll (Phase 4, owner decision 2026-06-30). EDGAR has no push webhook, so the
 * coverage trigger is a poll: for each covered company, check its recent filings and, for any new
 * one (a form we cover, not seen before), record the arrival and enqueue a coverage-pass job.
 *
 * Idempotency is shared with the filing webhook: both dedupe on webhook_deliveries
 * (source='filing', idempotency_key=accession), so a filing caught by both is processed once.
 */
import { query } from "../db/pool";
import { SecAdapter } from "../sources/sec";
import { bossQueue } from "../queue/boss";
import { JOB, type Queue } from "../queue/types";
import { FUNDAMENTALS_CONFIG, type FundamentalsConfig } from "../config/fundamentals";

const MONITORED_STATUSES = ["in_research", "in_review", "published", "monitoring"];

export interface FilingPollResult {
  companies: number;
  filings_seen: number;
  new_filings: number;
  enqueued: number;
}

interface CompanyRow {
  id: string;
  legal_name: string;
  primary_ticker: string;
  cik: string | null;
}

const isoMinusDays = (days: number): string =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

export async function runFilingPoll(opts: {
  sec?: SecAdapter;
  queue?: Queue;
  companyIds?: string[];
  sinceDays?: number;
  config?: FundamentalsConfig;
} = {}): Promise<FilingPollResult> {
  const sec = opts.sec ?? new SecAdapter();
  const queue = opts.queue ?? bossQueue;
  const config = opts.config ?? FUNDAMENTALS_CONFIG;
  // Only consider filings filed within this window, so the first poll doesn't enqueue all history.
  const cutoff = isoMinusDays(opts.sinceDays ?? 4);
  const result: FilingPollResult = { companies: 0, filings_seen: 0, new_filings: 0, enqueued: 0 };

  const companies = await query<CompanyRow>(
    opts.companyIds?.length
      ? "SELECT id, legal_name, primary_ticker, cik FROM companies WHERE id = ANY($1) AND cik IS NOT NULL"
      : "SELECT id, legal_name, primary_ticker, cik FROM companies WHERE coverage_status = ANY($1) AND cik IS NOT NULL",
    [opts.companyIds?.length ? opts.companyIds : MONITORED_STATUSES],
  );

  for (const company of companies.rows) {
    result.companies++;
    const filings = await sec.recentFilings(company.cik as string, { forms: config.triggerForms });
    if (!filings.ok || !filings.data) continue;

    for (const f of filings.data) {
      if (f.filing_date < cutoff) continue; // recent window only
      result.filings_seen++;

      // Claim the accession; ON CONFLICT means another path already recorded it.
      const claim = await query<{ id: string }>(
        `INSERT INTO webhook_deliveries (source, idempotency_key, company_id, payload)
         VALUES ('filing', $1, $2, $3) ON CONFLICT (source, idempotency_key) DO NOTHING RETURNING id`,
        [f.accession, company.id, { form_type: f.form, filing_url: f.url, filed_at: f.filing_date, via: "edgar_poll" }],
      );
      if (claim.rowCount === 0) continue;
      result.new_filings++;

      const jobId = await queue
        .enqueue(JOB.COVERAGE_PASS, { company_id: company.id, accession: f.accession, form_type: f.form, filing_url: f.url })
        .catch((e) => { console.warn(`[poll] enqueue failed for ${f.accession}: ${(e as Error).message}`); return null; });
      if (jobId) result.enqueued++;
    }
  }

  return result;
}
