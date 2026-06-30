/**
 * The isolated source-adapter interface (spec §8 reliability). Every external data
 * source returns this uniform shape so a single dead API never throws up the stack —
 * it degrades: ok=false, data=null, a missing[] note, and (when reached) provenance.
 */
export interface ProvenanceStamp {
  origin: string; // e.g. "SEC EDGAR"
  url: string;
  retrieved_at: string; // ISO
  title?: string | null;
}

export interface SourceResult<T> {
  ok: boolean;
  data: T | null;
  missing: string[]; // human-readable notes on what couldn't be fetched
  provenance: ProvenanceStamp | null;
  error?: string;
}

/** Injectable JSON fetcher so adapters can be tested against recorded fixtures, not live APIs. */
export type JsonFetcher = (url: string) => Promise<{ status: number; body: unknown }>;
