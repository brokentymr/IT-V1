/**
 * Keyless sentiment-platform adapters (Phase 7 input). Free sources, no API key:
 *   - StockTwits  api.stocktwits.com/api/2/streams/symbol/<T>.json   (retail bull/bear tags)
 *   - GDELT DOC   api.gdeltproject.org/api/v2/doc/doc?mode=tonechart (media tone) — rate-limited 1/5s
 *
 * Behind the isolated SourceResult interface (spec §8): a dead/limited source degrades (ok=false,
 * missing[] note) and the engine lowers confidence — it never throws up the stack. Injectable
 * JsonFetcher for fixture-based tests. (Our own news_notes are a third, always-available platform,
 * derived in the engine from data already collected — no adapter needed.)
 */
import type { JsonFetcher, SourceResult } from "./types";

const USER_AGENT = "Mozilla/5.0 (investing-together/0.1; brokentymr@gmail.com)";

export const liveSentimentFetcher: JsonFetcher = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
};

export interface StockTwitsMessage { created_at: string; body: string; sentiment: "Bullish" | "Bearish" | null }

interface StockTwitsBody { messages?: Array<{ created_at?: string; body?: string; entities?: { sentiment?: { basic?: string } | null } }> }

export function parseStockTwits(body: unknown): StockTwitsMessage[] {
  const msgs = (body as StockTwitsBody)?.messages;
  if (!Array.isArray(msgs)) return [];
  return msgs.map((m): StockTwitsMessage => ({
    created_at: m.created_at ?? "",
    body: (m.body ?? "").trim(),
    sentiment: m.entities?.sentiment?.basic === "Bullish" ? "Bullish" : m.entities?.sentiment?.basic === "Bearish" ? "Bearish" : null,
  })).filter((m) => m.body);
}

export class StockTwitsAdapter {
  constructor(private fetcher: JsonFetcher = liveSentimentFetcher) {}
  async streamSymbol(ticker: string): Promise<SourceResult<StockTwitsMessage[]>> {
    const url = `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(ticker.toUpperCase())}.json`;
    const retrieved_at = new Date().toISOString();
    try {
      const { status, body } = await this.fetcher(url);
      if (status !== 200 || !body) return { ok: false, data: null, missing: [`StockTwits ${ticker} HTTP ${status}`], provenance: { origin: "StockTwits", url, retrieved_at } };
      const msgs = parseStockTwits(body);
      return { ok: true, data: msgs, missing: [], provenance: { origin: "StockTwits", url, retrieved_at, title: ticker } };
    } catch (e) {
      return { ok: false, data: null, missing: [`StockTwits ${ticker}: ${(e as Error).message}`], provenance: { origin: "StockTwits", url, retrieved_at } };
    }
  }
}

export interface GdeltTone { avg_tone: number; volume: number }

interface GdeltToneBody { tonechart?: Array<{ bin?: number; count?: number }> }

export function parseGdeltTone(body: unknown): GdeltTone | null {
  const bins = (body as GdeltToneBody)?.tonechart;
  if (!Array.isArray(bins) || !bins.length) return null;
  let weighted = 0;
  let volume = 0;
  for (const b of bins) {
    const bin = Number(b.bin ?? 0);
    const count = Number(b.count ?? 0);
    weighted += bin * count;
    volume += count;
  }
  if (volume === 0) return null;
  return { avg_tone: weighted / volume, volume };
}

export class GdeltToneAdapter {
  constructor(private fetcher: JsonFetcher = liveSentimentFetcher) {}
  async tone(queryPhrase: string): Promise<SourceResult<GdeltTone>> {
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`"${queryPhrase}"`)}&mode=tonechart&format=json`;
    const retrieved_at = new Date().toISOString();
    try {
      const { status, body } = await this.fetcher(url);
      if (status !== 200 || !body) return { ok: false, data: null, missing: [`GDELT "${queryPhrase}" HTTP ${status}`], provenance: { origin: "GDELT", url, retrieved_at } };
      const tone = parseGdeltTone(body);
      if (!tone) return { ok: false, data: null, missing: [`GDELT "${queryPhrase}": no tone data`], provenance: { origin: "GDELT", url, retrieved_at } };
      return { ok: true, data: tone, missing: [], provenance: { origin: "GDELT", url, retrieved_at, title: queryPhrase } };
    } catch (e) {
      return { ok: false, data: null, missing: [`GDELT "${queryPhrase}": ${(e as Error).message}`], provenance: { origin: "GDELT", url, retrieved_at } };
    }
  }
}
