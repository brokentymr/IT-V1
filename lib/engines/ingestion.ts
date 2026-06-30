/**
 * Engine 1 — Ingestion / Identity (spec §4.1, §9.1).
 * ticker in → company index record + canonical skeleton + seeded peer links,
 * with provenance to a Tier-1 source and a confidence + missing-sources list (§8).
 *
 * Built on free SEC EDGAR; GICS via the SIC crosswalk (Phase 1 decision). Deterministic
 * (no LLM), so it costs nothing against the $50 ceiling. `ingestByCik` adds a CIK-direct path
 * for pre-IPO S-1 filers that have a CIK but no ticker yet.
 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTransaction } from "../db/pool";
import { SecAdapter, type SecIdentity } from "../sources/sec";
import type { ProvenanceStamp } from "../sources/types";
import { classifyFromSic } from "../gics/taxonomy";
import { Company, Market } from "../types";

// Below this, the classification is flagged for human review (reliability guardrail §8).
const CONFIDENCE_FLAG_THRESHOLD = 0.6;

const TV_PREFIX: Record<string, string> = {
  Nasdaq: "NASDAQ", NasdaqGS: "NASDAQ", NasdaqGM: "NASDAQ", NasdaqCM: "NASDAQ",
  NYSE: "NYSE", "NYSE American": "AMEX", NYSEArca: "NYSE", Cboe: "CBOE", CboeBZX: "CBOE", OTC: "OTC",
};

export interface IngestionResult {
  company_id: string;
  ticker: string;
  legal_name: string;
  cik: string;
  classification: { gics_sector: string | null; industry_group: string | null; industry: string | null; sub_industry: string | null };
  classification_confidence: number;
  missing_sources: string[];
  links_created: number;
  status: "created" | "updated";
  flagged: boolean;
}

function marketForExchange(exchange: string): Market {
  // SEC filers are US-listed; map every exchange to the US market facet.
  return { exchange, country: "US", region: "NA", currency: "USD", primary_filing_system: "SEC_EDGAR", calendar_ref: null };
}

function tradingViewSymbol(exchange: string | undefined, ticker: string): string | null {
  if (!exchange) return null;
  const prefix = TV_PREFIX[exchange] ?? exchange.replace(/[^A-Za-z]/g, "").toUpperCase();
  return `${prefix}:${ticker}`;
}

async function ensureMarketRow(client: PoolClient, m: Market): Promise<void> {
  await client.query(
    `INSERT INTO markets (exchange, country, region, currency, primary_filing_system)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (exchange) DO NOTHING`,
    [m.exchange, m.country, m.region, m.currency, m.primary_filing_system],
  );
}

/** Resolve a ticker via SEC EDGAR and persist the company (listed path). */
export async function ingestCompany(ticker: string, opts: { sec?: SecAdapter } = {}): Promise<IngestionResult> {
  const sec = opts.sec ?? new SecAdapter();
  const want = ticker.trim().toUpperCase();
  const resolved = await sec.resolveTicker(want);
  if (!resolved.ok || !resolved.data) throw new Error(`Ingestion failed for ${want}: ${resolved.missing.join("; ") || "ticker not resolvable"}`);
  const identity = await sec.companyIdentity(resolved.data.cik);
  if (!identity.ok || !identity.data) throw new Error(`Ingestion failed for ${want}: ${identity.missing.join("; ") || "no submissions record"}`);
  return persistIdentity(identity.data, identity.provenance, identity.missing, { primaryTicker: want, listing: "listed" });
}

/** Ingest a company directly by CIK — for pre-IPO S-1 filers that have a CIK but no ticker yet. */
export async function ingestByCik(cik: string, opts: { sec?: SecAdapter; listing?: "listed" | "pre_ipo" } = {}): Promise<IngestionResult> {
  const sec = opts.sec ?? new SecAdapter();
  const identity = await sec.companyIdentity(cik);
  if (!identity.ok || !identity.data) throw new Error(`Ingestion by CIK ${cik} failed: ${identity.missing.join("; ") || "no submissions record"}`);
  const primaryTicker = identity.data.tickers[0] ?? null;
  return persistIdentity(identity.data, identity.provenance, identity.missing, {
    primaryTicker, listing: opts.listing ?? (primaryTicker ? "listed" : "pre_ipo"),
  });
}

async function persistIdentity(
  sec_id: SecIdentity,
  provenance: ProvenanceStamp | null,
  identityMissing: string[],
  opts: { primaryTicker: string | null; listing: "listed" | "pre_ipo" | "private" },
): Promise<IngestionResult> {
  const missing = [...identityMissing];
  const gics = classifyFromSic(sec_id.sic);
  if (gics.gics_sector === null) missing.push(`GICS sector unresolved from ${gics.basis}`);

  const tickers = sec_id.tickers.length ? sec_id.tickers : (opts.primaryTicker ? [opts.primaryTicker] : []);
  const primaryExchange = sec_id.exchanges[0];
  const markets = [...new Set(sec_id.exchanges)].map(marketForExchange);
  const company = Company.parse({
    id: randomUUID(),
    identifiers: { legal_name: sec_id.legal_name, tickers, cik: sec_id.cik },
    classification: { gics_sector: gics.gics_sector, industry_group: gics.industry_group, industry: gics.industry, sub_industry: gics.sub_industry },
    markets: markets.length ? markets : [marketForExchange("Unknown")],
    tradingview_symbol: opts.primaryTicker ? tradingViewSymbol(primaryExchange, opts.primaryTicker) : null,
    coverage: { status: "watchlist", authors: [], next_earnings_date: null, positions_held: [] },
    content_refs: [],
  });
  const flagged = gics.confidence < CONFIDENCE_FLAG_THRESHOLD;

  const result = await withTransaction(async (client) => {
    for (const m of company.markets) await ensureMarketRow(client, m);

    // Idempotent on CIK (present for every SEC-sourced company; a pre-IPO filer may have no ticker).
    const existing = await client.query<{ id: string }>("SELECT id FROM companies WHERE cik = $1", [sec_id.cik]);
    let companyId: string;
    let status: "created" | "updated";

    if (existing.rows[0]) {
      companyId = existing.rows[0].id;
      status = "updated";
      await client.query(
        `UPDATE companies SET legal_name=$2, primary_ticker=$3, cik=$4, identifiers=$5, classification=$6, markets=$7,
           tradingview_symbol=$8, coverage=$9, gics_sector=$10, sub_industry=$11, listing=$12, classification_confidence=$13
         WHERE id=$1`,
        [companyId, company.identifiers.legal_name, opts.primaryTicker, company.identifiers.cik, company.identifiers,
          company.classification, JSON.stringify(company.markets), company.tradingview_symbol, company.coverage,
          company.classification.gics_sector, company.classification.sub_industry, opts.listing, gics.confidence],
      );
    } else {
      companyId = company.id;
      status = "created";
      await client.query(
        `INSERT INTO companies (id, legal_name, primary_ticker, cik, identifiers, classification, markets,
           tradingview_symbol, coverage, coverage_status, gics_sector, sub_industry, listing, classification_confidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [companyId, company.identifiers.legal_name, opts.primaryTicker, company.identifiers.cik, company.identifiers,
          company.classification, JSON.stringify(company.markets), company.tradingview_symbol, company.coverage,
          company.coverage.status, company.classification.gics_sector, company.classification.sub_industry, opts.listing, gics.confidence],
      );
    }

    const cf = await client.query<{ id: string }>(
      `INSERT INTO canonical_files (company_id) VALUES ($1)
       ON CONFLICT (company_id) DO UPDATE SET company_id = EXCLUDED.company_id RETURNING id`,
      [companyId],
    );
    await client.query("UPDATE companies SET canonical_file_ref=$2 WHERE id=$1", [companyId, cf.rows[0].id]);

    const src = await client.query<{ id: string }>(
      `INSERT INTO sources (company_id, tier, kind, origin, url, title, retrieved_at, metadata)
       VALUES ($1, 1, 'api', $2, $3, $4, now(), $5) RETURNING id`,
      [companyId, provenance?.origin ?? "SEC EDGAR", provenance?.url ?? null,
        company.identifiers.legal_name, { sic: sec_id.sic, sic_description: sec_id.sic_description, basis: gics.basis }],
    );

    // Seed peer links: existing companies in the same GICS industry_group → thematic_peer (both directions).
    let links_created = 0;
    const group = company.classification.industry_group;
    if (group) {
      const peers = await client.query<{ id: string }>(
        `SELECT id FROM companies WHERE id <> $1 AND classification->>'industry_group' = $2`,
        [companyId, group],
      );
      for (const peer of peers.rows) {
        for (const [from, to] of [[companyId, peer.id], [peer.id, companyId]] as const) {
          const r = await client.query(
            `INSERT INTO company_links (from_company_id, to_company_id, type, cross_sector, strength, rationale, source_ref, status)
             VALUES ($1,$2,'thematic_peer',false,'weak',$3,$4,'unverified')
             ON CONFLICT (from_company_id, to_company_id, type) DO NOTHING`,
            [from, to, `Same GICS industry group: ${group}`, src.rows[0].id],
          );
          links_created += r.rowCount ?? 0;
        }
      }
    }

    return { companyId, status, links_created };
  });

  return {
    company_id: result.companyId,
    ticker: opts.primaryTicker ?? "",
    legal_name: company.identifiers.legal_name,
    cik: sec_id.cik,
    classification: company.classification,
    classification_confidence: gics.confidence,
    missing_sources: missing,
    links_created: result.links_created,
    status: result.status,
    flagged,
  };
}
