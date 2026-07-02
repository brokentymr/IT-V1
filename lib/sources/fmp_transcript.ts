/**
 * Financial Modeling Prep (FMP) earnings-call transcript adapter.
 *
 * Returns the VERBATIM earnings-call transcript (prepared remarks + Q&A). FMP is the first concrete
 * TranscriptSource: cheap, has a free tier, and covers ~8,000 US names with a calendar→transcript
 * pipeline. Key in .env as FMP_API_KEY (never committed); absent → available()=false → the coverage
 * pass falls back to the Perplexity summary. Injectable fetcher so tests never hit the live API.
 *
 * Endpoints are config-overridable (FMP has migrated paths over time); the parser is tolerant of the
 * common response shapes ([{content,...}] or {content,...}).
 */
import type { SourceResult, JsonFetcher, ProvenanceStamp } from "./types";
import type { TranscriptSource, TranscriptDoc, TranscriptSegment } from "./transcript";

const ORIGIN = "FMP (earnings transcript)";
const BASE = () => process.env.FMP_BASE_URL || "https://financialmodelingprep.com";
const FETCH_TIMEOUT_MS = Number(process.env.SOURCE_FETCH_TIMEOUT_MS ?? 15_000);

const liveFetcher: JsonFetcher = async (url) => {
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const body = res.status === 200 ? await res.json() : null;
  return { status: res.status, body };
};

/** Split a raw transcript into speaker segments when it uses the common "Name: text" line convention. */
export function segmentTranscript(raw: string): TranscriptSegment[] {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const segs: TranscriptSegment[] = [];
  const speakerRe = /^([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3})(?:\s*[-–]\s*([^:]{2,60}))?:\s*(.*)$/;
  for (const line of lines) {
    const m = line.match(speakerRe);
    if (m && m[1].length <= 40) {
      segs.push({ speaker: m[1], role: m[2]?.trim() ?? null, text: m[3] ?? "" });
    } else if (segs.length) {
      segs[segs.length - 1].text += ` ${line}`;
    } else {
      segs.push({ speaker: null, role: null, text: line });
    }
  }
  return segs.length ? segs : [{ speaker: null, role: null, text: raw }];
}

/** Pull the transcript object out of FMP's response (array-of-one or bare object), tolerant of field names. */
function parseTranscript(body: unknown): { content: string; date: string | null; year: number | null; quarter: number | null } | null {
  const row = Array.isArray(body) ? body[0] : body;
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const content = (r.content ?? r.transcript ?? r.text) as string | undefined;
  if (!content || typeof content !== "string" || content.trim().length < 40) return null;
  const date = (r.date ?? r.datetime ?? null) as string | null;
  return {
    content,
    date: date ? String(date).slice(0, 10) : null,
    year: r.year != null ? Number(r.year) : null,
    quarter: r.quarter != null ? Number(r.quarter) : (r.period != null ? Number(String(r.period).replace(/\D/g, "")) || null : null),
  };
}

export class FmpTranscriptSource implements TranscriptSource {
  readonly name = "fmp";
  constructor(private readonly fetchJson: JsonFetcher = liveFetcher) {}

  available(): boolean {
    return !!process.env.FMP_API_KEY;
  }

  private url(symbol: string, opts: { year?: number; quarter?: number }): string {
    const key = process.env.FMP_API_KEY ?? "";
    const params = new URLSearchParams({ symbol: symbol.toUpperCase(), apikey: key });
    if (opts.year) params.set("year", String(opts.year));
    if (opts.quarter) params.set("quarter", String(opts.quarter));
    const path = process.env.FMP_TRANSCRIPT_PATH || "/stable/earning-call-transcript";
    return `${BASE()}${path}?${params.toString()}`;
  }

  async earningsTranscript(symbol: string, opts: { year?: number; quarter?: number } = {}): Promise<SourceResult<TranscriptDoc>> {
    const url = this.url(symbol, opts);
    const stamp: ProvenanceStamp = { origin: ORIGIN, url: url.replace(/apikey=[^&]+/, "apikey=***"), retrieved_at: new Date().toISOString() };
    if (!this.available()) return { ok: false, data: null, missing: ["FMP_API_KEY not set"], provenance: stamp };
    try {
      const { status, body } = await this.fetchJson(url);
      if (status !== 200 || body == null) return { ok: false, data: null, missing: [`FMP transcript HTTP ${status}`], provenance: stamp };
      const t = parseTranscript(body);
      if (!t) return { ok: false, data: null, missing: [`no transcript for ${symbol}${opts.quarter ? ` Q${opts.quarter} ${opts.year}` : ""}`], provenance: stamp };
      const doc: TranscriptDoc = {
        symbol: symbol.toUpperCase(),
        event_type: "earnings_call",
        title: `${symbol.toUpperCase()} earnings call${t.quarter ? ` Q${t.quarter} ${t.year ?? ""}`.trim() : ""}`,
        date: t.date,
        provider: this.name,
        url: stamp.url,
        raw: t.content,
        segments: segmentTranscript(t.content),
      };
      return { ok: true, data: doc, missing: [], provenance: { ...stamp, title: doc.title } };
    } catch (err) {
      return { ok: false, data: null, missing: ["FMP transcript unreachable"], provenance: stamp, error: (err as Error).message };
    }
  }
}
