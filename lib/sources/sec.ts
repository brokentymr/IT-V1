/**
 * SEC EDGAR source adapter (free, keyless — only a descriptive User-Agent is required).
 * Resolves a ticker to a company identity (CIK, legal name, SIC, exchanges, tickers).
 *
 * Endpoints:
 *   ticker → CIK : https://www.sec.gov/files/company_tickers.json
 *   submissions  : https://data.sec.gov/submissions/CIK##########.json
 *
 * The adapter takes an injectable JsonFetcher so tests run against recorded fixtures.
 */
import type { JsonFetcher, ProvenanceStamp, SourceResult, TextFetcher } from "./types";

const ORIGIN = "SEC EDGAR";
const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SUBMISSIONS_URL = (cik10: string) => `https://data.sec.gov/submissions/CIK${cik10}.json`;
const COMPANYFACTS_URL = (cik10: string) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10}.json`;
const FTS_URL = (q: string, forms: string) =>
  `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${q}"`)}&forms=${encodeURIComponent(forms)}`;

function userAgent(): string {
  return process.env.SEC_USER_AGENT ?? "investing-together/0.1 (brokentymr@gmail.com)";
}

/** Default live fetcher with the SEC-required User-Agent and a small retry/backoff. */
/** Per-request timeout so a slow/blocking host degrades (spec §8) instead of hanging the pass. */
const FETCH_TIMEOUT_MS = Number(process.env.SOURCE_FETCH_TIMEOUT_MS ?? 15_000);

export const liveJsonFetcher: JsonFetcher = async (url) => {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": userAgent(), Accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }
      const body = res.status === 200 ? await res.json() : null;
      return { status: res.status, body };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error("fetch failed");
};

/** Default live text fetcher (filing primary documents are HTML, not JSON). */
export const liveTextFetcher: TextFetcher = async (url, headers) => {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": userAgent(), ...(headers ?? {}) },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }
      return { status: res.status, text: res.status === 200 ? await res.text() : "" };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error("fetch failed");
};

export function cik10(cik: string | number): string {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

/** Strip leading zeros — the /Archives/edgar/data path uses the un-padded CIK. */
export function cikBare(cik: string | number): string {
  return String(Number(cik10(cik)));
}

export interface FilingRef {
  accession: string;        // e.g. "0000320193-24-000123"
  form: string;             // "10-K" | "10-Q" | "8-K" | ...
  filing_date: string;      // YYYY-MM-DD (filed)
  report_date: string | null; // period of report
  primary_document: string; // e.g. "aapl-20240928.htm"
  url: string;              // resolved primary-document URL
}

/** Build the primary-document URL for a filing (spec §9.2 archival reference). */
export function filingDocUrl(cik: string | number, accession: string, primaryDocument: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${cikBare(cik)}/${accession.replace(/-/g, "")}/${primaryDocument}`;
}

export interface SecIdentity {
  cik: string; // 10-digit
  legal_name: string;
  tickers: string[];
  exchanges: string[];
  sic: string | null;
  sic_description: string | null;
  fiscal_year_end: string | null;
}

/** XBRL company facts: us-gaap concept → unit → array of period-tagged values. */
export interface XbrlUnitValue {
  start?: string;
  end: string;
  val: number;
  fy?: number;
  fp?: string;          // FY | Q1 | Q2 | Q3
  form?: string;        // 10-K | 10-Q
  accn?: string;        // filing accession this value came from
  frame?: string;
}
export interface CompanyFacts {
  cik: string;
  entity_name: string;
  facts: Record<string, Record<string, { label?: string; units: Record<string, XbrlUnitValue[]> }>>;
}

export class SecAdapter {
  constructor(
    private readonly fetchJson: JsonFetcher = liveJsonFetcher,
    private readonly fetchText: TextFetcher = liveTextFetcher,
  ) {}

  /** Resolve a ticker symbol to its CIK + title via company_tickers.json. */
  async resolveTicker(ticker: string): Promise<SourceResult<{ cik: string; title: string; ticker: string }>> {
    const stamp: ProvenanceStamp = { origin: ORIGIN, url: TICKERS_URL, retrieved_at: new Date().toISOString() };
    try {
      const { status, body } = await this.fetchJson(TICKERS_URL);
      if (status !== 200 || !body || typeof body !== "object") {
        return { ok: false, data: null, missing: [`company_tickers.json (HTTP ${status})`], provenance: stamp };
      }
      const want = ticker.trim().toUpperCase();
      for (const row of Object.values(body as Record<string, { cik_str: number; ticker: string; title: string }>)) {
        if (row?.ticker?.toUpperCase() === want) {
          return {
            ok: true,
            data: { cik: cik10(row.cik_str), title: row.title, ticker: row.ticker.toUpperCase() },
            missing: [],
            provenance: stamp,
          };
        }
      }
      return { ok: false, data: null, missing: [`ticker ${want} not found in SEC universe`], provenance: stamp };
    } catch (err) {
      return { ok: false, data: null, missing: ["SEC ticker index unreachable"], provenance: stamp, error: (err as Error).message };
    }
  }

  /** Fetch the company submissions record (identity, SIC, exchanges) for a CIK. */
  async companyIdentity(cik: string | number): Promise<SourceResult<SecIdentity>> {
    const id = cik10(cik);
    const url = SUBMISSIONS_URL(id);
    const stamp: ProvenanceStamp = { origin: ORIGIN, url, retrieved_at: new Date().toISOString() };
    try {
      const { status, body } = await this.fetchJson(url);
      if (status !== 200 || !body || typeof body !== "object") {
        return { ok: false, data: null, missing: [`submissions CIK${id} (HTTP ${status})`], provenance: stamp };
      }
      const b = body as {
        name?: string;
        sic?: string;
        sicDescription?: string;
        tickers?: string[];
        exchanges?: string[];
        fiscalYearEnd?: string;
      };
      const missing: string[] = [];
      if (!b.sic) missing.push("SIC code (classification will be unresolved)");
      if (!b.tickers?.length) missing.push("tickers");
      const data: SecIdentity = {
        cik: id,
        legal_name: b.name ?? "",
        tickers: (b.tickers ?? []).map((t) => t.toUpperCase()),
        exchanges: b.exchanges ?? [],
        sic: b.sic ?? null,
        sic_description: b.sicDescription ?? null,
        fiscal_year_end: b.fiscalYearEnd ?? null,
      };
      const ok = !!b.name;
      if (!ok) missing.push("company legal name");
      return { ok, data: ok ? data : null, missing, provenance: stamp };
    } catch (err) {
      return { ok: false, data: null, missing: ["SEC submissions unreachable"], provenance: stamp, error: (err as Error).message };
    }
  }

  /**
   * Recent filings for a CIK from the submissions record (the `filings.recent` parallel arrays),
   * most-recent first. `forms` filters by form type (e.g. ["10-K","10-Q","8-K"]).
   */
  async recentFilings(
    cik: string | number,
    opts: { forms?: string[] } = {},
  ): Promise<SourceResult<FilingRef[]>> {
    const id = cik10(cik);
    const url = SUBMISSIONS_URL(id);
    const stamp: ProvenanceStamp = { origin: ORIGIN, url, retrieved_at: new Date().toISOString() };
    try {
      const { status, body } = await this.fetchJson(url);
      if (status !== 200 || !body || typeof body !== "object") {
        return { ok: false, data: null, missing: [`submissions CIK${id} (HTTP ${status})`], provenance: stamp };
      }
      const recent = (body as { filings?: { recent?: Record<string, unknown[]> } }).filings?.recent;
      if (!recent || !Array.isArray(recent.accessionNumber)) {
        return { ok: false, data: null, missing: ["no recent filings in submissions"], provenance: stamp };
      }
      const want = opts.forms?.map((f) => f.toUpperCase());
      const n = recent.accessionNumber.length;
      const out: FilingRef[] = [];
      for (let i = 0; i < n; i++) {
        const form = String(recent.form?.[i] ?? "");
        if (want && !want.includes(form.toUpperCase())) continue;
        const accession = String(recent.accessionNumber[i]);
        const primaryDocument = String(recent.primaryDocument?.[i] ?? "");
        out.push({
          accession,
          form,
          filing_date: String(recent.filingDate?.[i] ?? ""),
          report_date: (recent.reportDate?.[i] as string) || null,
          primary_document: primaryDocument,
          url: primaryDocument ? filingDocUrl(id, accession, primaryDocument) : "",
        });
      }
      return { ok: true, data: out, missing: [], provenance: stamp };
    } catch (err) {
      return { ok: false, data: null, missing: ["SEC submissions unreachable"], provenance: stamp, error: (err as Error).message };
    }
  }

  /** Full XBRL company facts (us-gaap financial concepts) for a CIK. */
  async companyFacts(cik: string | number): Promise<SourceResult<CompanyFacts>> {
    const id = cik10(cik);
    const url = COMPANYFACTS_URL(id);
    const stamp: ProvenanceStamp = { origin: ORIGIN, url, retrieved_at: new Date().toISOString() };
    try {
      const { status, body } = await this.fetchJson(url);
      if (status !== 200 || !body || typeof body !== "object") {
        return { ok: false, data: null, missing: [`companyfacts CIK${id} (HTTP ${status})`], provenance: stamp };
      }
      const b = body as { cik?: number; entityName?: string; facts?: CompanyFacts["facts"] };
      if (!b.facts) return { ok: false, data: null, missing: ["companyfacts has no facts block"], provenance: stamp };
      return {
        ok: true,
        data: { cik: id, entity_name: b.entityName ?? "", facts: b.facts },
        missing: [],
        provenance: stamp,
      };
    } catch (err) {
      return { ok: false, data: null, missing: ["SEC companyfacts unreachable"], provenance: stamp, error: (err as Error).message };
    }
  }

  /**
   * Find a filer's CIK by company name via EDGAR full-text search, scoped to a form type (default
   * S-1/S-1/A). Used to resolve a pre-IPO company NAME → CIK when it has no ticker yet.
   */
  async searchByName(name: string, opts: { forms?: string } = {}): Promise<SourceResult<{ cik: string; name: string }>> {
    const url = FTS_URL(name, opts.forms ?? "S-1,S-1/A");
    const stamp: ProvenanceStamp = { origin: ORIGIN, url, retrieved_at: new Date().toISOString() };
    try {
      const { status, body } = await this.fetchJson(url);
      if (status !== 200 || !body || typeof body !== "object") {
        return { ok: false, data: null, missing: [`EDGAR FTS (HTTP ${status})`], provenance: stamp };
      }
      const hits = (body as { hits?: { hits?: Array<{ _source?: { ciks?: string[]; display_names?: string[] } }> } }).hits?.hits;
      const top = hits?.[0]?._source;
      const rawCik = top?.ciks?.[0];
      if (!rawCik) return { ok: false, data: null, missing: [`no S-1 filer named "${name}"`], provenance: stamp };
      return {
        ok: true,
        data: { cik: cik10(rawCik), name: (top?.display_names?.[0] ?? name).replace(/\s*\(CIK.*$/i, "").trim() },
        missing: [],
        provenance: stamp,
      };
    } catch (err) {
      return { ok: false, data: null, missing: ["EDGAR FTS unreachable"], provenance: stamp, error: (err as Error).message };
    }
  }

  /** Fetch a filing's primary document text (HTML). Used for grounded link enrichment. */
  async fetchFilingDocument(url: string): Promise<SourceResult<string>> {
    const stamp: ProvenanceStamp = { origin: ORIGIN, url, retrieved_at: new Date().toISOString() };
    try {
      const { status, text } = await this.fetchText(url);
      if (status !== 200 || !text) {
        return { ok: false, data: null, missing: [`filing document (HTTP ${status})`], provenance: stamp };
      }
      return { ok: true, data: text, missing: [], provenance: stamp };
    } catch (err) {
      return { ok: false, data: null, missing: ["filing document unreachable"], provenance: stamp, error: (err as Error).message };
    }
  }
}
