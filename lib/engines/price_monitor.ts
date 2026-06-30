/**
 * Price-anomaly salience monitor (Phase 6). The market's own signal, finally wired in. For each
 * covered listed asset it pulls daily bars (free, keyless), and when the latest close-to-close move
 * breaches the threshold it: opens/accumulates a price_action area of interest, attributes the move
 * across technical/macro/news/fundamental angles, and applies the verdict — so a move can be put to
 * bed (overreaction / confirmed) by technicals and macro WITHOUT waiting for the next filing, or
 * carried to it. Reuses the Phase 5.5 area machinery end-to-end.
 */
import { query } from "../db/pool";
import { PriceAdapter, latestReturn, dailyVol } from "../sources/prices";
import { PRICES_CONFIG, type PricesConfig } from "../config/prices";
import { accumulateArea, loadOpenAreas, applyResolutions, annotateArea } from "./areas_of_interest";
import type { PriceAttributor } from "./price_attribution";

const MONITORED_STATUSES = ["in_research", "in_review", "published", "monitoring"];

export interface PriceMonitorResult {
  companies: number;
  fetched: number;
  anomalies: number;
  areas_opened: number;
  areas_accumulated: number;
  resolved: number;
  carried: number;
  details: Array<{ ticker: string; date: string; move_pct: number; idiosyncratic_pct: number | null; verdict: string }>;
}

interface ThesisLite { one_liner: string | null; conviction: number | null; invalidation_triggers: string[] }

async function loadThesis(companyId: string): Promise<ThesisLite | null> {
  const { rows } = await query<{ content: { thesis?: { one_liner?: string; conviction?: number; invalidation_triggers?: string[] } } }>(
    "SELECT content FROM canonical_snapshots WHERE company_id = $1 ORDER BY as_of DESC, created_at DESC LIMIT 1",
    [companyId],
  );
  const t = rows[0]?.content?.thesis;
  if (!t) return null;
  return { one_liner: t.one_liner ?? null, conviction: t.conviction ?? null, invalidation_triggers: t.invalidation_triggers ?? [] };
}

export async function runPriceMonitor(opts: {
  prices?: PriceAdapter;
  attributor?: PriceAttributor;
  config?: PricesConfig;
  companyIds?: string[];
}): Promise<PriceMonitorResult> {
  const prices = opts.prices ?? new PriceAdapter();
  const config = opts.config ?? PRICES_CONFIG;
  const result: PriceMonitorResult = { companies: 0, fetched: 0, anomalies: 0, areas_opened: 0, areas_accumulated: 0, resolved: 0, carried: 0, details: [] };

  // Benchmark once (the idiosyncratic-vs-market denominator).
  const bench = await prices.dailyBars(config.benchmark, { days: config.lookbackDays });
  const benchRet = bench.ok && bench.data ? latestReturn(bench.data)?.ret ?? null : null;

  const companies = await query<{ id: string; legal_name: string; primary_ticker: string; next_earnings_date: string | null }>(
    opts.companyIds?.length
      ? "SELECT id, legal_name, primary_ticker, to_char(next_earnings_date,'YYYY-MM-DD') AS next_earnings_date FROM companies WHERE id = ANY($1) AND listing = 'listed' AND primary_ticker IS NOT NULL"
      : "SELECT id, legal_name, primary_ticker, to_char(next_earnings_date,'YYYY-MM-DD') AS next_earnings_date FROM companies WHERE coverage_status = ANY($1) AND listing = 'listed' AND primary_ticker IS NOT NULL",
    [opts.companyIds?.length ? opts.companyIds : MONITORED_STATUSES],
  );

  for (const c of companies.rows) {
    result.companies++;
    const bars = await prices.dailyBars(c.primary_ticker, { days: config.lookbackDays });
    if (!bars.ok || !bars.data) continue;
    result.fetched++;

    const lr = latestReturn(bars.data);
    if (!lr || Math.abs(lr.ret) < config.anomalyMovePct) continue;
    result.anomalies++;

    const vol = dailyVol(bars.data);
    const sigma = vol ? lr.ret / vol : null;
    const idio = benchRet != null ? lr.ret - benchRet : null;
    const band: "material" | "major" = Math.abs(lr.ret) >= config.majorMovePct ? "major" : "material";
    const score = Math.min(100, Math.round(Math.abs(lr.ret) * 1000)); // 4% → 40, 7% → 70, capped

    // Coincident news/event areas (the fusion: link the move to what the headlines already flagged).
    const open = await loadOpenAreas(c.id);
    const coincident = open.filter((a) => a.theme !== "price_action").map((a) => `[${a.theme}] ${a.title}`);
    const thesis = await loadThesis(c.id);

    const headline = `${c.primary_ticker} ${(lr.ret * 100).toFixed(1)}% on ${lr.date}`;
    const area = await accumulateArea({
      companyId: c.id, category: "price_action", band, score,
      headline, url: null, summary: headline, detectedAt: `${lr.date}T00:00:00Z`,
    });
    result[area.created ? "areas_opened" : "areas_accumulated"]++;

    let verdict = "leave_open";
    if (opts.attributor) {
      const technical = `${(lr.ret * 100).toFixed(1)}% move (close ${lr.prev.toFixed(2)} → ${lr.close.toFixed(2)}); ${(vol * 100).toFixed(1)}% daily vol over ${bars.data.length} sessions`;
      const attr = await opts.attributor.attribute({
        company: { legal_name: c.legal_name, ticker: c.primary_ticker },
        move: { date: lr.date, stock_pct: lr.ret, benchmark_pct: benchRet, idiosyncratic_pct: idio, sigma },
        technical, coincident_areas: coincident, thesis,
      }).catch((e) => { console.warn(`[price] attribution failed for ${c.primary_ticker}: ${(e as Error).message}`); return null; });

      if (attr) {
        verdict = attr.verdict;
        await annotateArea(area.id, attr.explanation);
        const applied = await applyResolutions({
          companyId: c.id, accession: `price:${lr.date}`, snapshotId: null,
          revisitAfter: c.next_earnings_date, resolutions: [{ theme: "price_action", verdict: attr.verdict, note: attr.note }],
        });
        result.resolved += applied.resolved;
        result.carried += applied.carried;
      }
    }

    result.details.push({ ticker: c.primary_ticker, date: lr.date, move_pct: Number((lr.ret * 100).toFixed(1)), idiosyncratic_pct: idio == null ? null : Number((idio * 100).toFixed(1)), verdict });
  }

  return result;
}
