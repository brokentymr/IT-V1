/**
 * Keyless daily price adapter (Phase 6 salience input). Free source, no API key:
 *   - Yahoo Finance chart  https://query1.finance.yahoo.com/v8/finance/chart/<sym>?interval=1d&range=2mo
 *
 * (Stooq's CSV endpoint moved behind a JS proof-of-work wall — unusable headless.) Behind the
 * isolated SourceResult interface (spec §8): a dead/limited source degrades (missing[] note) rather
 * than failing the run. Injectable JsonFetcher for fixture-based tests. Intraday/indicator depth
 * arrives separately via the TradingView alert layer; this is the daily close-to-close first cut.
 */
import type { JsonFetcher, SourceResult } from "./types";

export interface DailyBar {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const USER_AGENT = "Mozilla/5.0 (investing-together/0.1; brokentymr@gmail.com)";

export const livePriceFetcher: JsonFetcher = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
};

/** Yahoo symbol: US equities/ETFs pass through uppercased; indices keep their caret (e.g. ^GSPC). */
export function yahooSymbol(ticker: string): string {
  return ticker.startsWith("^") ? ticker : ticker.toUpperCase();
}

interface YahooChart {
  chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }> } }>; error?: unknown };
}

export function parseYahooChart(body: unknown): DailyBar[] {
  const r = (body as YahooChart)?.chart?.result?.[0];
  const ts = r?.timestamp;
  const q = r?.indicators?.quote?.[0];
  if (!ts || !q?.close) return [];
  const bars: DailyBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close[i];
    if (close == null) continue; // holiday / missing print
    bars.push({
      date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      open: q.open?.[i] ?? close, high: q.high?.[i] ?? close, low: q.low?.[i] ?? close,
      close, volume: q.volume?.[i] ?? 0,
    });
  }
  return bars; // oldest → newest
}

export class PriceAdapter {
  constructor(private fetcher: JsonFetcher = livePriceFetcher) {}

  async dailyBars(ticker: string, opts: { days?: number } = {}): Promise<SourceResult<DailyBar[]>> {
    const sym = yahooSymbol(ticker);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2mo`;
    const retrieved_at = new Date().toISOString();
    try {
      const { status, body } = await this.fetcher(url);
      if (status !== 200 || !body) {
        return { ok: false, data: null, missing: [`Yahoo ${sym} HTTP ${status}`], provenance: { origin: "Yahoo Finance", url, retrieved_at } };
      }
      const bars = parseYahooChart(body);
      if (!bars.length) {
        return { ok: false, data: null, missing: [`Yahoo ${sym}: no bars parsed`], provenance: { origin: "Yahoo Finance", url, retrieved_at } };
      }
      const trimmed = opts.days ? bars.slice(-opts.days) : bars;
      return { ok: true, data: trimmed, missing: [], provenance: { origin: "Yahoo Finance", url, retrieved_at, title: sym } };
    } catch (e) {
      return { ok: false, data: null, missing: [`Yahoo ${sym}: ${(e as Error).message}`], provenance: { origin: "Yahoo Finance", url, retrieved_at } };
    }
  }
}

/** Latest close-to-close simple return; null if fewer than 2 bars. */
export function latestReturn(bars: DailyBar[]): { date: string; ret: number; close: number; prev: number } | null {
  if (bars.length < 2) return null;
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  if (!prev.close) return null;
  return { date: last.date, ret: (last.close - prev.close) / prev.close, close: last.close, prev: prev.close };
}

/** Stdev of daily returns over the window (the "is this move unusual" denominator). */
export function dailyVol(bars: DailyBar[]): number {
  const rets: number[] = [];
  for (let i = 1; i < bars.length; i++) if (bars[i - 1].close) rets.push((bars[i].close - bars[i - 1].close) / bars[i - 1].close);
  if (rets.length < 2) return 0;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  return Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
}
