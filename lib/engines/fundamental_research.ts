/**
 * Engine 2 — Fundamental Research (spec §4.2). The two-pass loop around a known filing date.
 *
 *   Forward pass  — as next_earnings_date nears, frame expectations + confirm/break conditions
 *                   into current_events.forward_note and pre-warm the standing model.
 *   Coverage pass — on a filing's arrival: extract statements from XBRL (deterministic), refresh
 *                   the model, measure actual vs the forward expectations, draft the thesis,
 *                   APPEND a snapshot with the diff, enrich links from the filing, and run
 *                   read-through so the filing propagates to linked assets.
 *
 * Append-only (spec §8): every coverage run appends a new snapshot; re-runs never mutate a prior.
 */
import { randomUUID } from "node:crypto";
import { query, withTransaction } from "../db/pool";
import { SecAdapter } from "../sources/sec";
import { NasdaqEarningsAdapter, resolveNextEarningsDate, type NextDate } from "../sources/earnings";
import type { PerplexityFinance } from "../sources/perplexity";
import { extractStatements, buildModel, diffModels, type FinancialModel } from "../financials/model";
import { FUNDAMENTALS_CONFIG, type FundamentalsConfig } from "../config/fundamentals";
import { Thesis, ForwardNote, type ForwardNote as ForwardNoteT } from "../types";
import type { FundamentalsAnalyst } from "./fundamentals_analyst";
import type { NewsAnalyzer } from "./analyzer";
import { propagateReadThrough } from "./read_through";

interface CompanyRow {
  id: string;
  legal_name: string;
  primary_ticker: string;
  cik: string | null;
  gics_sector: string | null;
  coverage: { positions_held?: unknown[]; next_earnings_date?: string | null; next_earnings_date_override?: string | null };
  next_earnings_date: string | null;
}

async function loadCompany(companyId: string): Promise<CompanyRow | null> {
  const { rows } = await query<CompanyRow>(
    `SELECT id, legal_name, primary_ticker, cik, gics_sector, coverage,
            to_char(next_earnings_date,'YYYY-MM-DD') AS next_earnings_date
       FROM companies WHERE id = $1`,
    [companyId],
  );
  return rows[0] ?? null;
}

async function ensureCanonicalFile(companyId: string): Promise<{ id: string; rolling_outlook: string; forward: ForwardNoteT | null }> {
  await query("INSERT INTO canonical_files (company_id) VALUES ($1) ON CONFLICT (company_id) DO NOTHING", [companyId]);
  const { rows } = await query<{ id: string; current_events: { rolling_outlook?: string; forward_note?: unknown } }>(
    "SELECT id, current_events FROM canonical_files WHERE company_id = $1",
    [companyId],
  );
  const ce = rows[0].current_events ?? {};
  const forward = ce.forward_note ? ForwardNote.safeParse(ce.forward_note) : null;
  return { id: rows[0].id, rolling_outlook: ce.rolling_outlook ?? "", forward: forward?.success ? forward.data : null };
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);

interface MarketContextData { consensus: unknown; analyst_view: unknown; citations: string[] }

/** Fetch advisory consensus + analyst view from Perplexity (best-effort; null if nothing usable). */
async function fetchMarketContext(finance: PerplexityFinance, ticker: string): Promise<MarketContextData | null> {
  const [c, a] = await Promise.all([
    finance.consensus(ticker).catch(() => null),
    finance.analystView(ticker).catch(() => null),
  ]);
  const consensus = c?.ok ? c.data : null;
  const analyst_view = a?.ok ? a.data : null;
  if (!consensus && !analyst_view) return null;
  const citations = [c?.provenance?.url, a?.provenance?.url].filter((u): u is string => !!u);
  return { consensus, analyst_view, citations };
}

// ---------------------------------------------------------------------------
// Forward pass
// ---------------------------------------------------------------------------
export interface ForwardResult {
  company_id: string;
  next_earnings_date: string | null;
  date_method: NextDate["method"];
  days_until: number | null;
  within_window: boolean;
  focus_metrics: string[];
  wrote: boolean;
}

export async function runForwardPass(opts: {
  companyId: string;
  analyst: FundamentalsAnalyst;
  sec?: SecAdapter;
  nasdaq?: NasdaqEarningsAdapter;
  finance?: PerplexityFinance;
  config?: FundamentalsConfig;
  today?: string;
  force?: boolean;
}): Promise<ForwardResult> {
  const config = opts.config ?? FUNDAMENTALS_CONFIG;
  const sec = opts.sec ?? new SecAdapter();
  const today = opts.today ?? todayIso();
  const company = await loadCompany(opts.companyId);
  if (!company) throw new Error(`company ${opts.companyId} not found`);

  // Resolve the date: manual override → Nasdaq → cadence estimate from EDGAR history.
  const filings = company.cik ? (await sec.recentFilings(company.cik, { forms: ["10-K", "10-Q"] })).data ?? undefined : undefined;
  // Manual tier = an EXPLICIT owner override only. A previously auto-resolved date (stored in
  // coverage.next_earnings_date for indexing) must NOT mask re-resolution, or the first guess sticks.
  const next = await resolveNextEarningsDate({
    ticker: company.primary_ticker, today,
    manual: company.coverage?.next_earnings_date_override ?? null,
    perplexity: opts.finance, nasdaq: opts.nasdaq, filings,
  });

  const daysUntil = next.date ? Math.round((Date.parse(`${next.date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : null;
  const withinWindow = daysUntil != null && daysUntil >= 0 && daysUntil <= config.forwardLeadDays;

  // Persist the resolved date back to the company (promoted column + coverage jsonb).
  if (next.date) {
    await query(
      `UPDATE companies
          SET next_earnings_date = $2::date,
              coverage = jsonb_set(coverage, '{next_earnings_date}', to_jsonb($2::text))
        WHERE id = $1`,
      [company.id, next.date],
    );
  }

  if (!opts.force && !withinWindow) {
    return { company_id: company.id, next_earnings_date: next.date, date_method: next.method, days_until: daysUntil, within_window: false, focus_metrics: [], wrote: false };
  }

  // Pre-warm the standing model (latest reported figures, no accession filter).
  const cf = await ensureCanonicalFile(company.id);
  let standing: FinancialModel | null = null;
  if (company.cik) {
    const facts = await sec.companyFacts(company.cik);
    if (facts.ok && facts.data) standing = buildModel(extractStatements(facts.data, { config }).line_items);
  }

  const mc = opts.finance ? await fetchMarketContext(opts.finance, company.primary_ticker) : null;
  const frame = await opts.analyst.frameForward({
    company: { legal_name: company.legal_name, ticker: company.primary_ticker, gics_sector: company.gics_sector },
    next_earnings_date: next.date,
    rolling_outlook: cf.rolling_outlook,
    standing_model: {
      fiscal_period: standing?.fiscal_period ?? null,
      ratios: standing?.ratios ?? {},
      headline: standing ? Object.fromEntries(Object.entries(standing.line_items).map(([k, v]) => [k, v.value])) : {},
    },
    market_context: mc ? { consensus: mc.consensus, analyst_view: mc.analyst_view } : undefined,
  });

  const note: ForwardNoteT = ForwardNote.parse({
    as_of: new Date().toISOString(),
    next_earnings_date: next.date,
    expectations: frame.expectations,
    focus_metrics: frame.focus_metrics,
    confirm_conditions: frame.confirm_conditions,
    break_conditions: frame.break_conditions,
    source: "forward_pass",
  });
  await query(
    "UPDATE canonical_files SET current_events = jsonb_set(current_events, '{forward_note}', $2::jsonb) WHERE id = $1",
    [cf.id, JSON.stringify(note)],
  );

  return { company_id: company.id, next_earnings_date: next.date, date_method: next.method, days_until: daysUntil, within_window: withinWindow, focus_metrics: frame.focus_metrics, wrote: true };
}

// ---------------------------------------------------------------------------
// Coverage pass
// ---------------------------------------------------------------------------
export interface CoverageResult {
  company_id: string;
  snapshot_id: string;
  as_of: string;
  cycle_label: string;
  conviction: number;
  metrics_extracted: number;
  missing_metrics: string[];
  links_enriched: number;
  read_through_notes: number;
}

const CONCENTRATION_RE = /(customer|supplier|concentration|account(?:ed|s)? for|substantial portion|distributor|reseller|manufactured by|foundry|partner)/i;

/** Crude HTML→text + a window around concentration/relationship language (grounds link extraction). */
function concentrationExcerpt(html: string, budget: number): string {
  const text = html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
  const hits: string[] = [];
  const re = new RegExp(CONCENTRATION_RE, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && hits.join(" ").length < budget) {
    hits.push(text.slice(Math.max(0, m.index - 400), m.index + 400));
    re.lastIndex = m.index + 800;
  }
  return hits.join("\n…\n").slice(0, budget);
}

export async function runCoveragePass(opts: {
  companyId: string;
  accession: string;
  formType?: string | null;
  filingUrl?: string | null;
  analyst: FundamentalsAnalyst;
  newsAnalyzer?: NewsAnalyzer; // for read-through; omit to skip
  finance?: PerplexityFinance; // advisory consensus + analyst view; omit to skip
  sec?: SecAdapter;
  config?: FundamentalsConfig;
  trigger?: "filing" | "manual";
  asOf?: string;
}): Promise<CoverageResult> {
  const config = opts.config ?? FUNDAMENTALS_CONFIG;
  const sec = opts.sec ?? new SecAdapter();
  const trigger = opts.trigger ?? "filing";
  const company = await loadCompany(opts.companyId);
  if (!company) throw new Error(`company ${opts.companyId} not found`);
  if (!company.cik) throw new Error(`company ${company.primary_ticker} has no CIK; cannot run coverage`);

  const cf = await ensureCanonicalFile(company.id);

  // 1. Deterministic extraction grounded to this filing's accession.
  const facts = await sec.companyFacts(company.cik);
  if (!facts.ok || !facts.data) throw new Error(`XBRL company facts unavailable for ${company.primary_ticker}: ${facts.missing.join("; ")}`);
  const { line_items, missing } = extractStatements(facts.data, { accession: opts.accession, config });
  const model = buildModel(line_items);

  // 2. Prior snapshot's model → diff (first-class "what changed").
  const prior = await query<{ model: FinancialModel | null }>(
    "SELECT content->'fundamentals'->'model' AS model FROM canonical_snapshots WHERE company_id = $1 ORDER BY as_of DESC, created_at DESC LIMIT 1",
    [company.id],
  );
  const diff = diffModels(prior.rows[0]?.model ?? null, model);

  // 3. Advisory market context (Perplexity/Fiscal.ai) + thesis narration over the figures.
  const mc = opts.finance ? await fetchMarketContext(opts.finance, company.primary_ticker) : null;
  const draft = await opts.analyst.draftThesis({
    company: { legal_name: company.legal_name, ticker: company.primary_ticker, gics_sector: company.gics_sector },
    filing: { form: opts.formType ?? "Filing", accession: opts.accession, period: model.fiscal_period },
    model, diff,
    rolling_outlook: cf.rolling_outlook,
    forward_expectations: cf.forward?.expectations ?? null,
    market_context: mc ? { consensus: mc.consensus, analyst_view: mc.analyst_view } : undefined,
  });

  const asOf = opts.asOf ?? model.period_end ?? todayIso();
  const cycleLabel = `${opts.formType ?? "Filing"} ${model.fiscal_period ?? asOf}`;
  const snapshotId = randomUUID();

  // 4. Append the snapshot atomically with its source row (provenance for every line item).
  await withTransaction(async (client) => {
    const src = await client.query<{ id: string }>(
      `INSERT INTO sources (company_id, tier, kind, origin, url, title, retrieved_at, metadata)
       VALUES ($1, 1, 'filing', 'SEC EDGAR', $2, $3, now(), $4) RETURNING id`,
      [company.id, opts.filingUrl ?? null, `${opts.formType ?? "Filing"} ${opts.accession}`, { accession: opts.accession }],
    );
    const sourceId = src.rows[0].id;

    // Advisory market context gets its OWN source row (Perplexity/Fiscal.ai) — kept distinct from
    // the filing provenance so the XBRL numbers and the external context never blur together.
    let marketContext: Record<string, unknown> | undefined;
    if (mc) {
      const mcSrc = await client.query<{ id: string }>(
        `INSERT INTO sources (company_id, tier, kind, origin, url, title, retrieved_at, metadata)
         VALUES ($1, 2, 'api', 'Perplexity (Fiscal.ai)', $2, $3, now(), $4) RETURNING id`,
        [company.id, mc.citations[0] ?? null, `Market context ${company.primary_ticker}`, { citations: mc.citations }],
      );
      marketContext = {
        consensus: mc.consensus ?? null,
        analyst_view: mc.analyst_view ?? null,
        provenance: [{ claim_id: "market_context", source_ref: mcSrc.rows[0].id }],
      };
    }

    const thesis = Thesis.parse({
      one_liner: draft.one_liner,
      long_form: `${draft.long_form}\n\nActual vs expected: ${draft.actual_vs_expected}`,
      tensions: draft.tensions,
      catalysts: [],
      invalidation_triggers: draft.invalidation_triggers,
      conviction: draft.conviction,
      positions_held: (company.coverage?.positions_held as never[]) ?? [],
    });

    const content = {
      fundamentals: {
        statements: line_items,
        model,
        provenance: Object.keys(line_items).map((k) => ({ claim_id: `fundamentals.${k}`, source_ref: sourceId })),
      },
      ...(marketContext ? { market_context: marketContext } : {}),
      thesis,
      events: { filings: [{ accession: opts.accession, form: opts.formType ?? null, url: opts.filingUrl ?? null }] },
    };

    await client.query(
      `INSERT INTO canonical_snapshots
         (snapshot_id, canonical_file_id, company_id, as_of, cycle_label, trigger, conviction, filing_ref, content, diff)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [snapshotId, cf.id, company.id, asOf, cycleLabel, trigger, draft.conviction, opts.accession,
        JSON.stringify(content), JSON.stringify(diff)],
    );
  });

  // 5. Link enrichment from the filing text (grounded, best-effort, links only to known companies).
  let linksEnriched = 0;
  if (opts.filingUrl) {
    linksEnriched = await enrichLinksFromFiling(opts, company, sec, config).catch((e) => {
      console.warn(`[coverage] link enrichment failed: ${(e as Error).message}`);
      return 0;
    });
  }

  // 6. Read-through: the filing is the origin event; propagate to linked assets.
  let readThroughNotes = 0;
  if (opts.newsAnalyzer) {
    const rt = await propagateReadThrough(opts.newsAnalyzer, {
      noteId: snapshotId, companyId: company.id, companyName: company.legal_name,
      headline: `${company.legal_name} filed ${opts.formType ?? "a filing"}: ${draft.one_liner}`,
      summary: draft.actual_vs_expected, category: "guidance", sourceRef: null,
    }).catch((e) => { console.warn(`[coverage] read-through failed: ${(e as Error).message}`); return { notesCreated: 0, reached: [] }; });
    readThroughNotes = rt.notesCreated;
  }

  return {
    company_id: company.id, snapshot_id: snapshotId, as_of: asOf, cycle_label: cycleLabel,
    conviction: draft.conviction, metrics_extracted: Object.keys(line_items).length,
    missing_metrics: missing, links_enriched: linksEnriched, read_through_notes: readThroughNotes,
  };
}

/** Read named counterparties out of the filing and upsert links to companies already in our universe. */
async function enrichLinksFromFiling(
  opts: { accession: string; formType?: string | null; filingUrl?: string | null; analyst: FundamentalsAnalyst },
  company: CompanyRow,
  sec: SecAdapter,
  config: FundamentalsConfig,
): Promise<number> {
  const doc = await sec.fetchFilingDocument(opts.filingUrl as string);
  if (!doc.ok || !doc.data) return 0;
  const text = concentrationExcerpt(doc.data, config.linkTextBudget);
  if (!text) return 0;

  const extracted = await opts.analyst.extractLinks({
    company: { legal_name: company.legal_name, ticker: company.primary_ticker },
    filing: { form: opts.formType ?? "Filing" }, text,
  });

  let created = 0;
  for (const link of extracted.links) {
    // Match only to companies ALREADY covered — never auto-create (that is Ingestion's job).
    const match = await query<{ id: string; gics_sector: string | null }>(
      `SELECT id, gics_sector FROM companies
        WHERE ($1::text IS NOT NULL AND upper(primary_ticker) = upper($1))
           OR lower(legal_name) = lower($2) LIMIT 1`,
      [link.ticker, link.name],
    );
    const to = match.rows[0];
    if (!to || to.id === company.id) continue;
    const crossSector = !!company.gics_sector && !!to.gics_sector && company.gics_sector !== to.gics_sector;
    const res = await query(
      `INSERT INTO company_links (from_company_id, to_company_id, type, cross_sector, strength, direction_note, rationale, status)
       VALUES ($1,$2,$3,$4,'medium',$5,$6,'unverified')
       ON CONFLICT (from_company_id, to_company_id, type) DO NOTHING`,
      [company.id, to.id, link.type, crossSector, `from ${opts.formType ?? "filing"} ${opts.accession}`, link.rationale],
    );
    created += res.rowCount ?? 0;
  }
  return created;
}
