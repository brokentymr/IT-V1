/**
 * Agentic asset intake (Phase 5 follow-up). The operator types intent in natural language — a
 * company, several companies, or a sector/theme to drill into — and Perplexity (web-grounded)
 * resolves it to concrete entities with tickers + listing status. Listed names ingest via SEC
 * EDGAR; pre-IPO / private names get a tickerless record + a Perplexity research profile.
 */
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { query } from "../db/pool";
import { PerplexityClient } from "../sources/perplexity";
import { SecAdapter } from "../sources/sec";
import { ingestCompany, ingestByCik } from "./ingestion";
import { bossQueue } from "../queue/boss";
import { JOB, type Queue } from "../queue/types";
import { FUNDAMENTALS_CONFIG } from "../config/fundamentals";

export const ResolvedEntity = z.object({
  name: z.string(),
  ticker: z.string().nullable(),
  listing: z.enum(["listed", "pre_ipo", "private"]),
  exchange: z.string().nullable(),
  sector: z.string().nullable(),
  rationale: z.string(),
});
export type ResolvedEntity = z.infer<typeof ResolvedEntity>;
export const ResolveResult = z.object({
  entities: z.array(ResolvedEntity).default([]),
  // Research factors/topics the operator wants the analysis to emphasize (e.g. "device price increases").
  research_focus: z.array(z.string()).default([]),
});
export type ResolveResult = z.infer<typeof ResolveResult>;

/** Resolve free-text intent to concrete companies (names + tickers + listing status). */
export async function resolveEntities(
  text: string,
  opts: { client?: PerplexityClient; max?: number } = {},
): Promise<{ entities: ResolvedEntity[]; research_focus: string[]; error?: string }> {
  const client = opts.client ?? new PerplexityClient();
  const max = opts.max ?? 12;
  const question = `A research operator wants to add assets to a coverage universe. Their request:
"""${text}"""

Resolve like a sell-side analyst mapping the full competitive landscape and value chain — NOT just
the literal headline names. Rules:
- If they name one or more companies, resolve each (informal names too, e.g. "Google" → Alphabet).
- If they imply COMPETITORS or a SECTOR / THEME (or ask to "drill into" an area), surface the real
  investable landscape (up to ${max}) and do not stop at the obvious direct rivals. Include, where
  they genuinely belong in the conversation: (a) direct competitors; (b) SUBSTITUTE / in-house
  threats — e.g. hyperscaler custom silicon like Alphabet's TPUs or Amazon's Trainium; and (c) the
  key ADJACENT value-chain players that move on the same thesis — e.g. for AI-datacenter compute:
  HBM/memory (Micron, SK Hynix), storage (SanDisk / Western Digital), ASIC design partners
  (Broadcom, Marvell), foundry (TSMC), networking. If the operator names a number ("two biggest"),
  treat it as the CORE but still surface the other materially-relevant names — the operator selects
  which to keep.
- Include public AND private / pre-IPO companies where relevant.
For each company give: legal/common name; stock ticker if publicly listed (else null); listing =
"listed" | "pre_ipo" | "private" (use "pre_ipo" for companies that have filed to go public, e.g. an
S-1); primary exchange (or null); GICS sector (or null); a one-line rationale.

ALSO extract any RESEARCH FOCUS the operator specified — specific factors, topics, or questions they
want the analysis to emphasize (e.g. "device price increases", "demand destruction risk", "China
exposure"). If none is stated, return an empty list.
Return JSON: {"entities": [{"name": string, "ticker": string|null, "listing": "listed|pre_ipo|private",
"exchange": string|null, "sector": string|null, "rationale": string}], "research_focus": [string]}
In each rationale, state WHERE the company sits in the landscape (direct rival / custom-silicon
substitute / memory / storage / foundry / networking / etc.) and why it matters. Favor analytical
completeness over a literal minimal reading.`;

  const r = await client.askJSON({ question, schema: ResolveResult, maxTokens: 1500, purpose: "intake.resolve" });
  if (!r.ok || !r.data) return { entities: [], research_focus: [], error: r.missing.join("; ") || r.error };
  // Normalize tickers; cap the list.
  const entities = r.data.entities.slice(0, max).map((e) => ({ ...e, ticker: e.ticker ? e.ticker.toUpperCase() : null }));
  return { entities, research_focus: r.data.research_focus };
}

/** Create a tickerless company record (pre-IPO / private) if one doesn't already exist by name. */
export async function createUnlistedCompany(e: { name: string; sector: string | null; listing: "pre_ipo" | "private" }): Promise<{ company_id: string; status: "created" | "exists" }> {
  const existing = await query<{ id: string }>("SELECT id FROM companies WHERE lower(legal_name) = lower($1) LIMIT 1", [e.name]);
  if (existing.rows[0]) return { company_id: existing.rows[0].id, status: "exists" };
  const id = randomUUID();
  await query(
    `INSERT INTO companies (id, legal_name, primary_ticker, cik, identifiers, classification, markets, coverage,
                            coverage_status, gics_sector, listing, classification_confidence)
     VALUES ($1,$2,null,null,$3,$4,'[]',$5,'watchlist',$6,$7,0.3)`,
    [id, e.name, { legal_name: e.name, tickers: [] },
      { gics_sector: e.sector, industry_group: null, industry: null, sub_industry: null },
      { status: "watchlist", authors: [], positions_held: [] }, e.sector, e.listing],
  );
  return { company_id: id, status: "created" };
}

async function enqueueCoverage(companyId: string, cik: string, sec: SecAdapter, queue: Queue): Promise<string | null> {
  const f = await sec.recentFilings(cik, { forms: FUNDAMENTALS_CONFIG.triggerForms });
  const latest = f.data?.find((x) => /^10-[KQ]$/.test(x.form)) ?? f.data?.[0];
  if (!latest) return null;
  return queue.enqueue(JOB.COVERAGE_PASS, { company_id: companyId, accession: latest.accession, form_type: latest.form, filing_url: latest.url });
}

/** Persist the operator's research-focus directives onto the company (read by the engines). */
async function storeFocus(companyId: string, focus?: string[]): Promise<void> {
  if (!focus?.length) return;
  await query("UPDATE companies SET coverage = jsonb_set(coverage, '{research_focus}', $2::jsonb) WHERE id = $1",
    [companyId, JSON.stringify(focus)]).catch(() => {});
}

export interface AddOutcome {
  name: string;
  company_id: string | null;
  listing: string;
  result: "ingested" | "created" | "exists" | "failed";
  research: "coverage" | "profile" | "none";
  detail?: string;
}

/**
 * Add one resolved entity:
 *   listed              → SEC ingest by ticker → coverage.
 *   pre_ipo (has S-1)   → EDGAR name→CIK → ingest by CIK → coverage on the S-1.
 *   pre_ipo (no filing) / private → tickerless record → Perplexity profile.
 * autoRun kicks off the initial research. research_focus is stored on the company for the engines.
 */
export async function addResolvedEntity(
  e: ResolvedEntity,
  opts: { sec?: SecAdapter; queue?: Queue; autoRun?: boolean; research_focus?: string[] } = {},
): Promise<AddOutcome> {
  const sec = opts.sec ?? new SecAdapter();
  const queue = opts.queue ?? bossQueue;
  const autoRun = opts.autoRun ?? true;

  // Listed → ingest by ticker, run coverage.
  if (e.listing === "listed" && e.ticker) {
    try {
      const res = await ingestCompany(e.ticker, { sec });
      await storeFocus(res.company_id, opts.research_focus);
      const cik = (await query<{ cik: string | null }>("SELECT cik FROM companies WHERE id = $1", [res.company_id])).rows[0]?.cik;
      if (autoRun && cik) await enqueueCoverage(res.company_id, cik, sec, queue).catch(() => null);
      return { name: e.name, company_id: res.company_id, listing: "listed", result: res.status === "created" ? "ingested" : "exists", research: autoRun ? "coverage" : "none" };
    } catch (err) {
      return profileFallback(e, queue, autoRun, opts.research_focus, `not in SEC EDGAR (${(err as Error).message.slice(0, 70)})`);
    }
  }

  // Pre-IPO → look for an S-1 filer on EDGAR; if found, ingest by CIK and run coverage on the S-1.
  if (e.listing === "pre_ipo") {
    const found = await sec.searchByName(e.name, { forms: "S-1,S-1/A" });
    if (found.ok && found.data) {
      try {
        const res = await ingestByCik(found.data.cik, { sec, listing: "pre_ipo" });
        await storeFocus(res.company_id, opts.research_focus);
        if (autoRun) await enqueueCoverage(res.company_id, found.data.cik, sec, queue).catch(() => null);
        return { name: e.name, company_id: res.company_id, listing: "pre_ipo", result: res.status === "created" ? "ingested" : "exists", research: autoRun ? "coverage" : "none", detail: `S-1 filer (CIK ${found.data.cik})` };
      } catch { /* fall through to a profile */ }
    }
    return profileFallback(e, queue, autoRun, opts.research_focus);
  }

  // Private (no public filings) → record + profile.
  return profileFallback(e, queue, autoRun, opts.research_focus);
}

async function profileFallback(
  e: ResolvedEntity, queue: Queue, autoRun: boolean, focus?: string[], detail?: string,
): Promise<AddOutcome> {
  const listing = e.listing === "pre_ipo" ? "pre_ipo" : "private";
  const u = await createUnlistedCompany({ name: e.name, sector: e.sector, listing });
  await storeFocus(u.company_id, focus);
  if (autoRun) await queue.enqueue(JOB.PROFILE_PASS, { company_id: u.company_id }).catch(() => null);
  return { name: e.name, company_id: u.company_id, listing, result: u.status === "created" ? "created" : "exists", research: autoRun ? "profile" : "none", detail };
}
