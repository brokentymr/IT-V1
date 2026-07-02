/**
 * Transcript ingestion config (real earnings-call / event transcripts).
 *
 * SEC EDGAR does not host transcripts — earnings calls, analyst days, and product events (WWDC-type)
 * are not filed — so a transcript PROVIDER is required. This is provider-agnostic: the concrete source
 * is selected here and implements lib/sources/transcript.ts's TranscriptSource. FMP is the first adapter
 * (verbatim earnings-call transcripts, cheap, one-API pipeline). Everything degrades gracefully to the
 * Perplexity summary when no provider key is configured, so the pipeline never depends on a paid feed.
 *
 * Config-not-code: provider + budgets live here; keys live in .env (never committed).
 */
export type TranscriptProvider = "fmp" | "none";

export interface TranscriptConfig {
  /** Which provider to use. "none" (or a missing key) → fall back to the Perplexity summary. */
  provider: TranscriptProvider;
  /** Char budget of transcript text fed to the desk (a bounded lead + keyword windows, not the whole call). */
  excerptBudget: number;
  /** Keywords that locate the thesis-critical passages inside a raw transcript. */
  keywords: string[];
}

export const TRANSCRIPT_CONFIG: TranscriptConfig = {
  provider: (process.env.TRANSCRIPT_PROVIDER as TranscriptProvider) || "fmp",
  excerptBudget: 20_000,
  keywords: [
    "guidance", "outlook", "we expect", "next quarter", "full year",
    "committed", "commitment", "take-or-pay", "strategic customer", "long-term agreement", "multi-year", "backlog", "bookings",
    "demand", "sold out", "sold-out", "capacity", "utilization",
    "pricing", "ASP", "price", "gross margin", "margin",
    "HBM", "AI", "data center", "hyperscaler",
  ],
};
