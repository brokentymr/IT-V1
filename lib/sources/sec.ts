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
import type { JsonFetcher, ProvenanceStamp, SourceResult } from "./types";

const ORIGIN = "SEC EDGAR";
const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SUBMISSIONS_URL = (cik10: string) => `https://data.sec.gov/submissions/CIK${cik10}.json`;

function userAgent(): string {
  return process.env.SEC_USER_AGENT ?? "investing-together/0.1 (brokentymr@gmail.com)";
}

/** Default live fetcher with the SEC-required User-Agent and a small retry/backoff. */
export const liveJsonFetcher: JsonFetcher = async (url) => {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": userAgent(), Accept: "application/json" },
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

export function cik10(cik: string | number): string {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
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

export class SecAdapter {
  constructor(private readonly fetchJson: JsonFetcher = liveJsonFetcher) {}

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
}
