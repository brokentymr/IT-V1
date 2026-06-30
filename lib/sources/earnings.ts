/**
 * Forward earnings/filing-date discovery (Phase 4, owner decision 2026-06-30):
 *   primary  — Nasdaq's keyless per-ticker endpoint (a real, looked-up next-report date)
 *   fallback — cadence estimate from the company's own EDGAR filing history (deterministic)
 *   override — a manually-set companies.next_earnings_date always wins (handled by the caller)
 *
 * Both networked paths degrade to ok=false rather than throwing (spec §8). The date only drives
 * the forward pass's timing; the coverage pass (filing arrival) never depends on it.
 */
import type { JsonFetcher, ProvenanceStamp, SourceResult } from "./types";
import type { FilingRef } from "./sec";

const ORIGIN = "Nasdaq";
// Per-ticker earnings endpoint. Keyless but expects browser-like headers; overridable for testing.
const NASDAQ_URL = (ticker: string) =>
  process.env.NASDAQ_EARNINGS_URL?.replace("{ticker}", ticker.toUpperCase()) ??
  `https://api.nasdaq.com/api/company/${ticker.toUpperCase()}/earnings-date`;

const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/;
const US_DATE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/; // M/D/YYYY as Nasdaq sometimes renders

function toIsoDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const iso = v.match(ISO_DATE);
  if (iso) return iso[1];
  const us = v.match(US_DATE);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  return null;
}

/** Walk an arbitrary JSON blob for the first future date under an earnings-ish key. */
function findNextDate(node: unknown, today: string, depth = 0): string | null {
  if (depth > 6 || node == null) return null;
  if (Array.isArray(node)) {
    for (const v of node) {
      const d = findNextDate(v, today, depth + 1);
      if (d) return d;
    }
    return null;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (/date|report|earnings/i.test(k)) {
        const d = toIsoDate(v);
        if (d && d >= today) return d;
      }
      const nested = findNextDate(v, today, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

export class NasdaqEarningsAdapter {
  constructor(private readonly fetchJson: JsonFetcher) {}

  /** Best-effort next earnings/report date for a ticker; null if none is reported. */
  async nextEarningsDate(ticker: string, today: string): Promise<SourceResult<string | null>> {
    const url = NASDAQ_URL(ticker);
    const stamp: ProvenanceStamp = { origin: ORIGIN, url, retrieved_at: new Date().toISOString() };
    try {
      const { status, body } = await this.fetchJson(url);
      if (status !== 200 || !body || typeof body !== "object") {
        return { ok: false, data: null, missing: [`Nasdaq earnings date (HTTP ${status})`], provenance: stamp };
      }
      const date = findNextDate(body, today);
      return { ok: true, data: date, missing: date ? [] : ["no future earnings date reported"], provenance: stamp };
    } catch (err) {
      return { ok: false, data: null, missing: ["Nasdaq unreachable"], provenance: stamp, error: (err as Error).message };
    }
  }
}

/** ISO date arithmetic that avoids `Date.now()` — pass an explicit anchor date. */
function addDays(isoDate: string, days: number): string {
  const ms = Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Deterministic cadence estimate: project the next periodic report from the most recent 10-Q/10-K.
 * 10-Q → next print ~91 days out; an annual 10-K → next 10-Q ~91 days out as well. Approximate by
 * design (the real date refines via Nasdaq or a manual override), but always available offline.
 */
export function estimateFromCadence(filings: FilingRef[]): { date: string; basis: string } | null {
  const periodic = filings
    .filter((f) => /^10-[KQ]$/i.test(f.form) && f.filing_date)
    .sort((a, b) => (a.filing_date < b.filing_date ? 1 : -1));
  const last = periodic[0];
  if (!last) return null;
  const anchor = last.report_date || last.filing_date;
  return { date: addDays(anchor, 91), basis: `+91d from ${last.form} period ${anchor}` };
}

export interface NextDate {
  date: string | null;
  method: "manual" | "perplexity" | "nasdaq" | "cadence" | "unknown";
  basis: string;
}

/** Anything that can look up a next earnings date (Perplexity, Nasdaq) plugs in here. */
export interface EarningsDateSource {
  nextEarningsDate(ticker: string, today: string): Promise<SourceResult<string | null>>;
}

/**
 * Resolve a company's next earnings/filing date. Precedence: manual override → Perplexity (keyed,
 * Fiscal.ai-backed) → Nasdaq (keyless) → cadence estimate. `today` is passed explicitly so the
 * function stays pure/testable.
 */
export async function resolveNextEarningsDate(opts: {
  ticker: string;
  today: string;
  manual?: string | null;
  perplexity?: EarningsDateSource;
  nasdaq?: EarningsDateSource;
  filings?: FilingRef[];
}): Promise<NextDate> {
  if (opts.manual) return { date: opts.manual, method: "manual", basis: "companies.next_earnings_date override" };
  for (const [tier, src] of [["perplexity", opts.perplexity], ["nasdaq", opts.nasdaq]] as const) {
    if (!src) continue;
    const r = await src.nextEarningsDate(opts.ticker, opts.today);
    if (r.ok && r.data) return { date: r.data, method: tier, basis: r.provenance?.url ?? tier };
  }
  if (opts.filings?.length) {
    const est = estimateFromCadence(opts.filings);
    if (est) return { date: est.date, method: "cadence", basis: est.basis };
  }
  return { date: null, method: "unknown", basis: "no source available" };
}
