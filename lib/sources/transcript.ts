/**
 * Provider-agnostic transcript source — real, verbatim call/event transcripts (not a summary).
 *
 * A TranscriptSource returns the actual spoken content of an event (earnings call, and — where the
 * provider supports it — analyst day / product event), so the desk reads primary passages and cites
 * them ("transcript [date]"), instead of a lossy LLM paraphrase. Adapters (FMP first) implement this
 * behind an injectable fetcher and degrade to ok=false when no key/data is present.
 */
import type { SourceResult, JsonFetcher } from "./types";
import { TRANSCRIPT_CONFIG } from "../config/transcript";
import { FmpTranscriptSource } from "./fmp_transcript";

export type TranscriptEventType = "earnings_call" | "analyst_day" | "product_event" | "other";

export interface TranscriptSegment {
  speaker: string | null;
  role: string | null;
  text: string;
}

export interface TranscriptDoc {
  symbol: string;
  event_type: TranscriptEventType;
  title: string;
  date: string | null; // ISO (YYYY-MM-DD) when known
  provider: string;
  url: string | null;
  raw: string; // full transcript text (verbatim)
  segments: TranscriptSegment[]; // speaker-segmented when the provider supplies it; else one segment
}

export interface TranscriptSource {
  readonly name: string;
  /** True when the source is configured (key present) and can be called. */
  available(): boolean;
  /** The most recent earnings-call transcript (optionally a specific fiscal year/quarter). */
  earningsTranscript(symbol: string, opts?: { year?: number; quarter?: number }): Promise<SourceResult<TranscriptDoc>>;
  /** Analyst day / product event transcript — only some providers cover these (optional). */
  eventTranscript?(symbol: string, opts: { type: TranscriptEventType; since?: string }): Promise<SourceResult<TranscriptDoc>>;
}

const htmlish = (s: string): string => s.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();

/**
 * A bounded, thesis-relevant excerpt of a (possibly very long) transcript: the LEAD (prepared remarks
 * open with the guidance + strategic narrative) plus keyword windows around the demand/guidance/
 * committed-volume/pricing language. Keeps the desk prompt cheap while preserving what matters.
 */
export function transcriptExcerpt(doc: TranscriptDoc, budget = TRANSCRIPT_CONFIG.excerptBudget, keywords = TRANSCRIPT_CONFIG.keywords): string {
  const text = htmlish(doc.raw);
  if (text.length <= budget) return text;
  const lead = text.slice(0, Math.floor(budget * 0.45));
  const lower = text.toLowerCase();
  const windows: string[] = [];
  let used = lead.length;
  for (const kw of keywords) {
    const k = kw.toLowerCase();
    if (k.length < 3) continue;
    let idx = lower.indexOf(k, lead.length);
    let perKw = 0;
    while (idx >= 0 && perKw < 2 && used < budget) {
      const w = text.slice(Math.max(0, idx - 220), idx + 220);
      windows.push(w);
      used += w.length;
      perKw++;
      idx = lower.indexOf(k, idx + 440);
    }
    if (used >= budget) break;
  }
  return `${lead}\n…\n${windows.join("\n…\n")}`.slice(0, budget);
}

/** Labeled evidence block for the desk — primary spoken content, citable as "transcript". */
export function transcriptEvidenceBlock(doc: TranscriptDoc, budget?: number): string {
  const when = doc.date ? ` (${doc.date})` : "";
  const kind = doc.event_type.replace("_", " ");
  return `EARNINGS-CALL / EVENT TRANSCRIPT — ${kind}${when}, VERBATIM primary source via ${doc.provider} (cite as 'transcript'). Read the narrative and judge the forward guidance:\n${transcriptExcerpt(doc, budget)}`;
}

/**
 * Resolve the configured transcript source. Returns null when disabled or unconfigured (no key), so
 * callers fall back to the Perplexity summary. Injectable fetcher for tests.
 */
export function resolveTranscriptSource(fetchJson?: JsonFetcher): TranscriptSource | null {
  if (TRANSCRIPT_CONFIG.provider === "none") return null;
  if (TRANSCRIPT_CONFIG.provider === "fmp") {
    const src = new FmpTranscriptSource(fetchJson);
    return src.available() ? src : null;
  }
  return null;
}
