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
import { query, withTransaction, getPool } from "../db/pool";
import { SecAdapter, type CompanyFacts } from "../sources/sec";
import { NasdaqEarningsAdapter, resolveNextEarningsDate, type NextDate } from "../sources/earnings";
import type { PerplexityFinance, PerplexityClient } from "../sources/perplexity";
import {
  extractStatements, buildModel, diffModels, stats,
  metricYoYGrowths, netMarginLevels, priorYearBaseForNext, type FinancialModel, type SnapshotDiff,
} from "../financials/model";
import { simulateScenario, mulberry32, type ScenarioOutput } from "../financials/montecarlo";
import { concentrationExcerpt, extractMdaSection, keywordExcerpts, earningsReleaseExcerpt } from "../financials/filing_text";
import { FUNDAMENTALS_CONFIG, PBEAT_CONFIG, type FundamentalsConfig } from "../config/fundamentals";
import { trailingBeatRate, pbeatDivergenceNote } from "../financials/pbeat_divergence";
import { DESK_CONFIG, type DeskConfig } from "../config/desk";
import { llmSpendThisMonth } from "../llm/client";
import { Thesis, ForwardNote, type ForwardNote as ForwardNoteT, type Driver } from "../types";
import { demandBriefing, type FundamentalsAnalyst, type DemandProfile, type NonGaapReconciliation } from "./fundamentals_analyst";
import { ClaudeResearchPanel, type ResearchPanel, type ResearchEnrich } from "./research";
import type { AutoCommitInput, AutoCommitResult } from "./autocommit";
import type { NewsAnalyzer } from "./analyzer";
import { propagateReadThrough } from "./read_through";
import { loadOpenAreas, applyResolutions, type OpenArea } from "./areas_of_interest";
import { detectSurprises, surpriseBriefing, type Observation } from "./surprise";
import { applyGroundingGate } from "./grounding";
import { ClaudeRetrievalPlanner } from "./retrieval_planner";
import { fetchTranscript, fetchMarketData, fetchEventTranscript, externalBlock } from "./external_evidence";
import { resolveTranscriptSource, transcriptEvidenceBlock, type TranscriptSource } from "../sources/transcript";
import { reconcileScenario } from "../financials/reconcile";
import { computeLevers, leversBriefing } from "../financials/levers";
import { buildBasisBlock, reconcileBases, scanUnlabeledBasis } from "../financials/basis";
import { computeTrends } from "../financials/trends";
import { checkIdentities, identityLog } from "../financials/identity";
import { scoreDisclosureCoverage, coverageScorecardLog } from "../financials/coverage_scorer";
import { DISCLOSURE_KEYWORDS, DISCLOSURE_TEXT_BUDGET } from "../config/disclosure_checklist";
import { checkConsistency, type ComputedFacts } from "./consistency";
import { checkRiskTriggerJoin, blocks, type RiskJoinFinding } from "./risk_join";
import { positioningComplete, type PositioningDesk, type PositioningDecision } from "./positioning";
import { quarantineText, buildVerifiedClaims } from "../provenance/numeric";
import { persistNumericClaims } from "../provenance/store";
import { PROVENANCE_CONFIG } from "../config/provenance";
import { buildClaimDag, propagateRestatement, retractFact } from "./claim_dag";
import { CLAIM_DAG_CONFIG } from "../config/claim_dag";
import { positioningReadout } from "./positioning_readout";
import { POSITIONING_CONFIG } from "../config/positioning";
import { PriceAdapter } from "../sources/prices";
import { buildPriceContext, type PriceContext } from "./price_context";
import { upsertReadThrough, linkReadThroughMatch } from "./read_through_relationships";

interface CompanyRow {
  id: string;
  legal_name: string;
  primary_ticker: string;
  cik: string | null;
  gics_sector: string | null;
  listing: string;
  coverage: { positions_held?: unknown[]; next_earnings_date?: string | null; next_earnings_date_override?: string | null; research_focus?: string[] };
  next_earnings_date: string | null;
}

async function loadCompany(companyId: string): Promise<CompanyRow | null> {
  const { rows } = await query<CompanyRow>(
    `SELECT id, legal_name, primary_ticker, cik, gics_sector, listing, coverage,
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

interface PriceContextResult { ctx: PriceContext; url: string; retrieved_at: string }

/**
 * Verified live-price anchor for the desk pass (best-effort). Pulls the recent daily-bar window via the
 * keyless PriceAdapter and derives the staleness signal against the (advisory) sell-side target, so the
 * report anchors on a fetched, timestamped quote instead of a hand-typed price. Returns null only when
 * there is no ticker; a dead price source still returns a context (ok:false) so the caller can degrade.
 */
async function fetchPriceContext(
  ticker: string | null,
  analystTarget: number | null,
  targetAsOf: string | null,
  adapter: PriceAdapter,
): Promise<PriceContextResult | null> {
  if (!ticker) return null;
  const bars = await adapter.dailyBars(ticker).catch(() => null);
  const ctx = buildPriceContext({ bars: bars?.ok ? bars.data : null, analystTarget, targetAsOf });
  return { ctx, url: bars?.provenance?.url ?? "https://finance.yahoo.com", retrieved_at: bars?.provenance?.retrieved_at ?? new Date().toISOString() };
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
  dedupe?: boolean; // skip framing if a forward note is already staged for this exact earnings date
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

  // No-duplicate guard (the scheduler): a forward note already staged for THIS exact earnings date
  // means the cycle is pre-warmed — skip the (costly) re-frame. A moved date won't match, so it re-stages.
  if (opts.dedupe && !opts.force && next.date && cf.forward?.next_earnings_date === next.date) {
    return { company_id: company.id, next_earnings_date: next.date, date_method: next.method, days_until: daysUntil, within_window: true, focus_metrics: cf.forward.focus_metrics ?? [], wrote: false };
  }

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
  // Control P12: uncovered counterparties + demand customers recorded as read-through relationship edges.
  read_through_relationships: number;
  drivers_extracted: number;
  scenario: ScenarioOutput | null;
  confidence: number;
  grounded_coverage: number; // pipeline upgrade §2: fraction of load-bearing claims backed by evidence
  needs_review: boolean;
  areas_addressed: number;
  areas_resolved: number;
  areas_carried: number;
  // Workstream C (auto-commit) — defaulted when no autoCommit is wired (e.g. in fundamentals tests).
  committed: boolean;
  published_status: string;
  content_job_id: string | null;
  deepen_rounds: number;
  // Control P4 (claim dependency DAG) — defaulted (0) when the DAG build/propagation is skipped or fails.
  claims_built: number;
  claims_stale_flagged: number;
  // Control P5 (per-filing-type disclosure coverage scorer).
  coverage_gaps: number;
  coverage_scorecard_ok: boolean;
}

export async function runCoveragePass(opts: {
  companyId: string;
  accession: string;
  formType?: string | null;
  filingUrl?: string | null;
  analyst: FundamentalsAnalyst;
  panel?: ResearchPanel; // the analyst desk (multi-expert + synthesis + adversarial verify)
  newsAnalyzer?: NewsAnalyzer; // for read-through; omit to skip
  finance?: PerplexityFinance; // advisory consensus + analyst view; omit to skip
  perplexity?: PerplexityClient; // Workstream C: targeted deepening enrich queries; omit to skip
  sec?: SecAdapter;
  config?: FundamentalsConfig;
  deskConfig?: DeskConfig; // Workstream C: deepening policy; defaults to DESK_CONFIG
  trigger?: "filing" | "manual";
  asOf?: string;
  rng?: () => number; // injectable for deterministic Monte Carlo in tests
  focusOverride?: string[]; // per-run research focus (chat "Deepen research now"); merged, not persisted
  autoCommit?: (input: AutoCommitInput) => Promise<AutoCommitResult>; // Workstream C; omit to skip publish
  positioningDesk?: PositioningDesk; // pipeline upgrade: the decision engine; omit to skip (tests/eval)
  transcriptSource?: TranscriptSource; // real verbatim transcript provider; omit → resolve from config/env (degrades)
  priceAdapter?: PriceAdapter; // verified live-price anchor; defaults to the keyless Yahoo adapter, injectable for tests
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

  // 1b. Deterministic accounting-identity gate (MU-audit control P1). Runs BEFORE any narrative reasons
  // over the numbers: a hard failure means the figures aren't trustworthy, so implicated metrics are
  // kept out of the surprise investigator (no fabricated explanation of a broken number) and the thesis
  // is held for human review rather than auto-published. The report is stamped on the snapshot as the
  // "gate executed" audit log.
  const integrity = checkIdentities(model);
  console.log(`[coverage] ${company.primary_ticker} ${identityLog(integrity)}`);
  const integritySuppressed = new Set(integrity.violations.flatMap((x) => x.metrics));

  // 2. Prior snapshot's model → diff (first-class "what changed").
  const prior = await query<{ model: FinancialModel | null }>(
    "SELECT content->'fundamentals'->'model' AS model FROM canonical_snapshots WHERE company_id = $1 ORDER BY as_of DESC, created_at DESC LIMIT 1",
    [company.id],
  );
  const diff = diffModels(prior.rows[0]?.model ?? null, model);

  // 3. Advisory market context (Perplexity/Fiscal.ai) + thesis narration over the figures.
  const mc = opts.finance ? await fetchMarketContext(opts.finance, company.primary_ticker) : null;
  // 3a. Verified live-price anchor + staleness guard. Fetched EARLY so every downstream reader (the
  // positioning decision, the P12 fair-value readout, the auto-commit gate) reasons off a fetched,
  // timestamped quote — not a hand-typed price — and knows when the market has repriced ahead of a
  // possibly-stale sell-side target. Best-effort: a dead price source degrades to an unusable context.
  const av = (mc?.analyst_view ?? null) as { price_target_usd?: number | null; target_as_of?: string | null } | null;
  const priceCtx = await fetchPriceContext(
    company.primary_ticker,
    av?.price_target_usd ?? null,
    av?.target_as_of ?? null,
    opts.priceAdapter ?? new PriceAdapter(),
  );
  if (priceCtx?.ctx.ok) {
    console.log(`[coverage] ${company.primary_ticker} price ${priceCtx.ctx.note}`);
  }
  // 3b. Filing document (fetched once, reused for MD&A drivers + link enrichment). Resilient to a
  // missing filingUrl: the feeders (filing webhook / EDGAR poll) sometimes drop the primary-document
  // URL, and without it the entire qualitative half — MD&A drivers (#3c), the forward scenario (#4),
  // demand (below), hypotheses — silently no-ops while the XBRL half still commits at high grounding,
  // publishing a driverless snapshot as if complete. When the URL is absent, resolve it from the
  // accession before fetching.
  let filingUrl = opts.filingUrl;
  if (!filingUrl) {
    const recent = await sec.recentFilings(company.cik, { forms: config.triggerForms }).catch(() => null);
    filingUrl = recent?.data?.find((f) => f.accession === opts.accession)?.url ?? null;
  }
  let html: string | null = null;
  if (filingUrl) {
    const doc = await sec.fetchFilingDocument(filingUrl).catch(() => null);
    html = doc?.ok ? doc.data : null;
  }
  if (!html) {
    console.warn(
      `[coverage] no filing document for ${company.primary_ticker} ${opts.accession} (filingUrl=${filingUrl ?? "unresolved"}); ` +
        `running quant-only — MD&A drivers, forward scenario, demand, and hypotheses will be absent`,
    );
  }

  // 3b-bis. Earnings release (8-K Item 2.02 EX-99.1) — the management NARRATIVE + forward GUIDANCE the
  // quarterly call paints, which the 10-Q/XBRL do not carry (e.g. total committed volume across strategic
  // agreements vs the narrow ASC 606 RPO). Free, primary (EDGAR). Best-effort; the pass degrades without it.
  let releaseText: string | null = null;
  let releaseUrl: string | null = null;
  if (company.cik) {
    try {
      const er = await sec.earningsRelease(company.cik);
      if (er.ok && er.data) {
        releaseUrl = er.data.url;
        const doc = await sec.fetchFilingDocument(er.data.url).catch(() => null);
        releaseText = doc?.ok && doc.data ? earningsReleaseExcerpt(doc.data, config.mdaTextBudget) : null;
      }
      console.log(`[coverage] ${company.primary_ticker} earnings release: ${releaseText ? `ingested (${releaseUrl})` : `unavailable — ${er.missing.join("; ")}`}`);
    } catch (e) {
      console.warn(`[coverage] earnings release fetch failed: ${(e as Error).message}`);
    }
  }

  // 3c. MD&A drivers (#3) → Monte Carlo next-period scenario (#4). Both best-effort.
  let drivers: Driver[] = [];
  if (html) {
    const mda = extractMdaSection(html, config.mdaTextBudget);
    if (mda) {
      const dr = await opts.analyst.extractDrivers({
        company: { legal_name: company.legal_name, ticker: company.primary_ticker },
        filing: { form: opts.formType ?? "Filing" }, mda_text: mda, research_focus: company.coverage?.research_focus,
      }).catch((e) => { console.warn(`[coverage] driver extraction failed: ${(e as Error).message}`); return { drivers: [] as Driver[] }; });
      drivers = dr.drivers;
    }
  }

  // Demand/supply extraction (grounding upgrade): pull the demand-side levers — customers, concentration,
  // segment/geo mix, order/backlog and supply signals — from the PRIMARY filing text. Grounded to the
  // filing, so the desk reasons over sourced customer facts rather than priors. Best-effort; skipped
  // when the analyst has no extractDemand (tests) or there's no filing document.
  let demand: DemandProfile | null = null;
  if (html && opts.analyst.extractDemand) {
    const demandText = [concentrationExcerpt(html, config.linkTextBudget), extractMdaSection(html, Math.floor(config.mdaTextBudget / 2))].filter(Boolean).join("\n\n");
    if (demandText) {
      demand = await opts.analyst.extractDemand({
        company: { legal_name: company.legal_name, ticker: company.primary_ticker },
        filing: { form: opts.formType ?? "Filing" }, text: demandText,
      }).catch((e) => { console.warn(`[coverage] demand extraction failed: ${(e as Error).message}`); return null; });
    }
  }

  const scenario = buildScenario(facts.data, model, drivers, mc?.consensus ?? null, company, config, opts.rng);

  // Statistical floor (control P7): compare the model-implied P(beat consensus) against the company's own
  // trailing beat rate (fraction of trailing quarters that grew revenue YoY). A large divergence is a
  // momentum PROXY worth flagging — never a forecast. Null (no note) when either rate is unavailable.
  const trailingRate = trailingBeatRate(facts.data, PBEAT_CONFIG, config);
  const pbeatDivergence = scenario
    ? pbeatDivergenceNote(scenario.beat_probability, trailingRate, model, scenario.sensitivity, PBEAT_CONFIG)
    : null;

  // 3d. Open areas of interest — the between-filing developments the News Monitor accumulated. The
  // desk reasons over them explicitly, then adjudicates which this filing resolves (step 7).
  const openAreas = await loadOpenAreas(company.id);

  // 3d-bis. Surprise investigation (pipeline upgrade): flag figures that deviate sharply from the
  // company's own history or consensus, and instruct the desk to EXPLAIN them rather than dismiss
  // them as errors. This is what stops the desk from rejecting a true, market-moving print.
  // Metrics that failed the identity gate are NOT fed to the investigator: a period-mismatched OCF is
  // an extraction error, not a "surprise to explain" — feeding it here is what produced the fabricated
  // $18B-SCA-deposit narrative in the Micron report (MU-audit control P2).
  const surprises = detectSurprises(buildSurpriseObservations(model, prior.rows[0]?.model ?? null, integritySuppressed));
  const briefing = surpriseBriefing(surprises);

  // 3d-ter. Model coherence (pipeline upgrade §5): do the drivers and the Monte Carlo tell the same
  // story? An incoherent quant is surfaced to the desk (and stamped on the snapshot) rather than
  // presented as one model.
  const coherence = reconcileScenario(drivers, scenario?.bands?.revenue_growth ?? null);

  // Financial levers (ROE/DuPont + balance-sheet health) computed from the XBRL — ground-truth,
  // citable to the filing. Fed to the desk so its claims about returns and the balance sheet are grounded.
  const levers = computeLevers(model, /^10-K/i.test(opts.formType ?? "") ? 365 : 91);

  // Basis labeling (control P11): every XBRL line item is GAAP; the FCF bridge is company-defined
  // (adjusted). Best-effort: if the analyst can read the filing's non-GAAP reconciliation table, we
  // reconcile GAAP vs non-GAAP EPS/margins. Non-blocking — this only labels/annotates, never gates.
  const basisBlock = buildBasisBlock(model, levers);
  let nonGaap: NonGaapReconciliation | null = null;
  if (html && opts.analyst.extractNonGaap) {
    const nonGaapText = [concentrationExcerpt(html, Math.floor(config.linkTextBudget / 2)), extractMdaSection(html, Math.floor(config.mdaTextBudget / 2))].filter(Boolean).join("\n\n");
    if (nonGaapText) {
      nonGaap = await opts.analyst.extractNonGaap({
        company: { legal_name: company.legal_name, ticker: company.primary_ticker },
        filing: { form: opts.formType ?? "Filing" }, text: nonGaapText,
      }).catch((e) => { console.warn(`[coverage] non-GAAP extraction failed: ${(e as Error).message}`); return null; });
    }
  }
  if (nonGaap) basisBlock.reconciliations = reconcileBases(model, nonGaap);

  // W3: multi-year trend context from the filing history — grounds baseline/cyclicality claims.
  const trends = computeTrends(metricYoYGrowths(facts.data, "revenue", config), netMarginLevels(facts.data, config), model.ratios.net_margin ?? null);

  const evidenceBase = buildEvidence(model, diff, drivers, scenario, mc, openAreas, `${opts.formType ?? "Filing"} ${opts.accession} (period ${model.fiscal_period ?? "?"})`, briefing, pbeatDivergence);
  const demandBrief = demand ? demandBriefing(demand) : "";
  const trendBrief = trends.read ? `\n\n${trends.read}` : "";
  // Control P11 basis disclosure for the desk: figures are GAAP; FCF is company-defined (adjusted);
  // any GAAP vs non-GAAP reconciliation is labeled so the desk never conflates the two bases.
  const basisBrief = `Reporting basis (control P11): line-item figures are GAAP; free cash flow is adjusted (company definition: operating cash flow − capex).`
    + (basisBlock.reconciliations.length ? ` GAAP vs non-GAAP: ${basisBlock.reconciliations.map((r) => `${r.metric} ${r.gaap_label} ${r.gaap_value} vs ${r.non_gaap_label} ${r.non_gaap_value}`).join("; ")}.` : "");
  const withLevers = `${evidenceBase}\n\n${leversBriefing(levers)}\n\n${basisBrief}${demandBrief ? `\n\n${demandBrief}` : ""}${trendBrief}`;
  // The earnings-release narrative + guidance is PRIMARY evidence (EDGAR 8-K) — read it to judge the
  // forward guidance and to characterize the numbers (e.g. committed volume vs the narrow ASC 606 RPO).
  const releaseBlock = releaseText
    ? `\n\nEARNINGS RELEASE — management narrative + forward guidance (8-K Item 2.02, PRIMARY/EDGAR — cite as 'earnings release'):\n${releaseText}`
    : "";
  const withRelease = `${withLevers}${releaseBlock}`;
  const evidence = coherence.agree ? withRelease : `${withRelease}\n\nMODEL COHERENCE WARNING: ${coherence.note}`;

  // 3e. The analyst desk: 4 expert lenses → senior synthesis → adversarial verification, wrapped in
  // the Workstream-C deepening loop. When verification is short of the bar, `enrich` gap-fills on the
  // WIRED sources only (a targeted re-read of this filing + targeted Perplexity/Fiscal.ai queries).
  const deskConfig = opts.deskConfig ?? DESK_CONFIG;
  const enrich: ResearchEnrich | undefined = (html || opts.perplexity)
    ? async ({ missing, unverified }) => {
        const parts: string[] = [];
        const sources: string[] = [];
        if (html) {
          const kw = [...new Set(
            [...unverified, ...missing].flatMap((s) => s.split(/[^a-zA-Z]+/)).filter((w) => w.length > 4).map((w) => w.toLowerCase()),
          )].slice(0, 10);
          const ex = keywordExcerpts(html, kw, Math.floor(deskConfig.enrichCharBudget / 2));
          if (ex) { parts.push(`Targeted re-read of ${opts.formType ?? "the filing"}:\n${ex}`); sources.push("SEC EDGAR (deepening re-read)"); }
        }
        if (opts.perplexity) {
          const topics = (missing.length ? missing : unverified).slice(0, deskConfig.enrichPerplexityBudget);
          for (const topic of topics) {
            const a = await opts.perplexity.askText({
              question: `For ${company.legal_name} (${company.primary_ticker}), give specific, sourced facts on: ${topic}. Cite figures and dates; be concise.`,
              maxTokens: 500, purpose: "research.deepen.enrich",
            }).catch(() => null);
            if (a?.ok && a.text) { parts.push(`On "${topic}" (Perplexity/Fiscal.ai): ${a.text}`); sources.push(`Perplexity: ${topic}`); }
          }
        }
        return parts.length ? { appended: parts.join("\n\n"), sources } : null;
      }
    : undefined;

  const researchFocus = [...new Set([...(company.coverage?.research_focus ?? []), ...(opts.focusOverride ?? [])])];

  // 3f. Retrieval planner (pipeline upgrade §2): fetch the specific facts a thesis needs BEFORE the
  // desk runs, so the panel reasons over sourced context instead of its own memory. Best-effort;
  // skipped without a Perplexity client (e.g. tests). Fetched context is labeled grounded.
  let evidenceForDesk = evidence;
  if (deskConfig.retrievalPlannerEnabled && opts.perplexity) {
    try {
      const figuresLine = Object.values(model.line_items)
        .map((x) => `${x.label} ${x.unit === "USD/shares" ? x.value.toFixed(2) : (Math.abs(x.value) >= 1e9 ? `$${(x.value / 1e9).toFixed(1)}B` : `$${(x.value / 1e6).toFixed(0)}M`)}`)
        .join("; ");
      const plan = await new ClaudeRetrievalPlanner().plan({
        company: { legal_name: company.legal_name, ticker: company.primary_ticker, gics_sector: company.gics_sector },
        figures: figuresLine, focus: researchFocus,
      });
      const fetched: string[] = [];
      for (const q of plan.questions) {
        const a = await opts.perplexity.askText({
          question: `For ${company.legal_name} (${company.primary_ticker}): ${q.question} Cite figures and dates; be concise.`,
          maxTokens: 400, purpose: "research.retrieval_fetch",
        }).catch(() => null);
        if (a?.ok && a.text) fetched.push(`- ${q.topic}: ${a.text}`);
      }
      if (fetched.length) {
        evidenceForDesk = `${evidence}\n\nSourced external context (retrieval planner — treat as grounded evidence):\n${fetched.join("\n")}`;
      }
    } catch (e) {
      console.warn(`[coverage] retrieval planner failed: ${(e as Error).message}`);
    }
  }

  // W2 — earnings-call transcript. PREFER a real, verbatim transcript (a configured provider such as
  // FMP) so the desk reads the actual spoken narrative + forward guidance and cites primary passages;
  // fall back to the Perplexity SUMMARY only when no transcript provider is configured or it has no
  // transcript for this name. This is what turns the call from "summarized" into "grounded".
  let transcriptMeta: { provider: string; date: string | null; url: string | null; event_type: string } | null = null;
  const transcriptSource = opts.transcriptSource ?? resolveTranscriptSource();
  if (transcriptSource) {
    const tr = await transcriptSource.earningsTranscript(company.primary_ticker).catch(() => null);
    if (tr?.ok && tr.data) {
      evidenceForDesk = `${evidenceForDesk}\n\n${transcriptEvidenceBlock(tr.data)}`;
      transcriptMeta = { provider: tr.data.provider, date: tr.data.date, url: tr.data.url, event_type: tr.data.event_type };
      console.log(`[coverage] ${company.primary_ticker} transcript: ${tr.data.provider} verbatim${tr.data.date ? ` (${tr.data.date})` : ""}`);
    } else {
      console.log(`[coverage] ${company.primary_ticker} transcript provider returned nothing (${tr?.missing.join("; ") ?? "n/a"}); falling back to summary`);
    }
  }

  // W2 fallback + W7: Perplexity earnings-call SUMMARY (only when no verbatim transcript landed) + the
  // third-party market/pricing data. Best-effort; skipped without Perplexity.
  if (opts.perplexity) {
    const ext = externalBlock([
      transcriptMeta ? null : await fetchTranscript(opts.perplexity, { legal_name: company.legal_name, ticker: company.primary_ticker }),
      // Best-effort analyst-day / product-event coverage (owner: free IR+web). Episodic — often null.
      await fetchEventTranscript(opts.perplexity, { legal_name: company.legal_name, ticker: company.primary_ticker }),
      await fetchMarketData(opts.perplexity, { legal_name: company.legal_name, ticker: company.primary_ticker, gics_sector: company.gics_sector }),
    ]);
    if (ext) evidenceForDesk = `${evidenceForDesk}\n\n${ext}`;
  }

  // Per-asset deepen budget: stop escalating once THIS run has spent deepenBudgetUsd (measured as the
  // ledger delta since the pass began). Round 0 always runs; only the deepening rounds are gated.
  const spendAtStart = await llmSpendThisMonth();
  const panel = opts.panel ?? new ClaudeResearchPanel({ config: deskConfig });
  const research = await panel.runResearch({
    company: { legal_name: company.legal_name, ticker: company.primary_ticker, gics_sector: company.gics_sector, listing: company.listing },
    evidence: evidenceForDesk,
    rolling_outlook: cf.rolling_outlook,
    forward_expectations: cf.forward?.expectations ?? null,
    research_focus: researchFocus.length ? researchFocus : undefined,
    enrich,
    withinBudget: async () => (await llmSpendThisMonth()) - spendAtStart < deskConfig.deepenBudgetUsd,
  });

  // Grounding gate (pipeline upgrade §2): a confident thesis carried mostly by ungrounded priors
  // (the Micron failure — only 2/13 claims backed by evidence) must not auto-publish. Downgrade to
  // review; the human checkpoint decides. Never upgrades review → auto.
  const grounding = applyGroundingGate(research.verification, deskConfig.minGroundedCoverage, { requireCitation: true });
  if (grounding.gated) {
    research.verification.recommendation = "review";
    console.log(`[coverage] grounding gate held ${company.primary_ticker} for review: ${grounding.reason}`);
  }
  const synth = research.thesis;

  // Control P11: scan the narrative for EPS/margin figures that differ from the labeled GAAP model
  // value with no basis word — an unlabeled non-GAAP number. Non-blocking; flags are stamped for review.
  const synthText = `${synth.one_liner} ${synth.long_form} ${(synth.invalidation_triggers ?? []).join(" ")} ${(synth.tensions ?? []).join(" ")}`;
  basisBlock.unlabeled_flags = scanUnlabeledBasis(synthText, model, nonGaap);
  if (basisBlock.unlabeled_flags.length) console.warn(`[coverage] ${company.primary_ticker} unlabeled-basis figures in narrative: ${basisBlock.unlabeled_flags.join(" | ")}`);

  // Provenance (control P3): every figure the pipeline computed is a verified located claim; any
  // invalidation trigger that asserts a CURRENCY figure with no grounding among those claims is
  // quarantined (dropped from the published triggers and flagged; blocks auto-publish below).
  const verifiedClaims = PROVENANCE_CONFIG.enabled ? buildVerifiedClaims(model, scenario, levers) : [];
  const q = PROVENANCE_CONFIG.enabled
    ? quarantineText(synth.invalidation_triggers, verifiedClaims, PROVENANCE_CONFIG)
    : { admitted: synth.invalidation_triggers, quarantined: [] as string[] };
  if (q.quarantined.length) console.warn(`[coverage] ${company.primary_ticker} quarantined ungrounded triggers: ${q.quarantined.join(" | ")}`);

  // Control P10: risks & triggers as one typed, joined system. Normalize ids deterministically when the
  // desk omits them (so the join is stable), then check the join — a trigger with no linking risk or no
  // verifiable disclosure BLOCKS auto-publish; an unlinked risk is a warning. Pure, modeled on the W6 check.
  const p10Risks = (synth.risks ?? []).map((r, i) => ({ ...r, id: r.id?.trim() || `r${i + 1}` }));
  const p10Triggers = (synth.triggers ?? []).map((t, i) => ({ ...t, id: t.id?.trim() || `t${i + 1}` }));
  const riskJoin: RiskJoinFinding[] = checkRiskTriggerJoin(p10Risks, p10Triggers);
  if (riskJoin.length) console.warn(`[coverage] ${company.primary_ticker} risk/trigger join: ${riskJoin.map((f) => `${f.kind}(${f.severity})`).join(", ")}`);

  // W6: consistency — do the desk's claims contradict the computed figures? Conflicts are held for review.
  const cfacts: ComputedFacts = {
    fcf_negative: levers.balance_sheet.free_cash_flow != null && levers.balance_sheet.free_cash_flow < 0,
    net_debt: levers.balance_sheet.net_cash != null && levers.balance_sheet.net_cash < 0,
    revenue_declining: (model.line_items.revenue?.yoy?.change_pct ?? 0) < 0,
    margin_declining:
      model.line_items.gross_profit?.yoy != null && model.line_items.revenue?.yoy != null &&
      model.line_items.gross_profit.yoy.change_pct < model.line_items.revenue.yoy.change_pct,
  };
  const consistencyText = `${synth.one_liner} ${synth.long_form} ${research.panel.flatMap((p) => p.claims.map((c) => c.statement)).join(" ")}`;
  const consistency = checkConsistency(cfacts, consistencyText);
  if (consistency.length) console.warn(`[coverage] ${company.primary_ticker} consistency conflicts: ${consistency.map((c) => c.fact).join(", ")}`);

  // Control P5: per-filing-type disclosure coverage scorer. Deterministic, non-LLM: checks the disclosures
  // a reader of this form expects (revenue/margins/EPS/OCF/capex/FCF, and conditionally guidance/RPO-backlog/
  // buyback/customer-concentration) are present in the model AND captured in the analysis. A missing CRITICAL
  // disclosure (no revenue, or an RPO/backlog figure disclosed in the filing but never captured — the F4 hold)
  // holds the thesis for review (scorecard.ok=false); expected/optional gaps are stamped for the report.
  // Forward %-of-revenue claims with no grounding are soft-flagged. Reads a bounded filing excerpt so the
  // if_disclosed checks see only the relevant disclosure language.
  const claimTexts = [
    synth.one_liner, synth.long_form, synth.actual_vs_expected ?? "",
    ...research.panel.flatMap((p) => p.claims.map((c) => c.statement)),
    ...drivers.flatMap((d) => [d.framing, d.quote ?? ""]),
  ].filter((s): s is string => !!s);
  // The scorer reads the 10-Q excerpt AND the earnings release, so guidance / committed-volume / SCA
  // disclosures that live only in the release are scored as covered (and their absence flagged).
  const disclosureText = [
    html ? keywordExcerpts(html, DISCLOSURE_KEYWORDS, DISCLOSURE_TEXT_BUDGET) : null,
    releaseText,
  ].filter(Boolean).join("\n…\n") || null;
  const scorecard = scoreDisclosureCoverage({
    formType: opts.formType ?? null, model, demand, drivers, claimTexts, filingText: disclosureText,
  });
  console.log(`[coverage] ${company.primary_ticker} ${coverageScorecardLog(scorecard)}`);

  // Positioning / decision (pipeline upgrade — Doc 2): convert the adjudicated research into an actual
  // CALL — stance, variant view, target range, dated catalysts, sizing. Injectable; skipped when not
  // wired (tests/eval). A description-only decision is blocked from auto-publish below.
  let positioning: PositioningDecision | null = null;
  if (opts.positioningDesk) {
    const rg = scenario?.bands?.revenue_growth;
    const eps = scenario?.bands?.eps;
    const scenarioSummary = rg
      ? `revenue growth P10/P50/P90 ${(rg.p10 * 100).toFixed(0)}/${(rg.p50 * 100).toFixed(0)}/${(rg.p90 * 100).toFixed(0)}%; EPS P10/P50/P90 ${eps ? `${eps.p10.toFixed(2)}/${eps.p50.toFixed(2)}/${eps.p90.toFixed(2)}` : "n/a"}; coherence: ${coherence.note}`
      : "no scenario available";
    positioning = await opts.positioningDesk.decide({
      company: { legal_name: company.legal_name, ticker: company.primary_ticker, listing: company.listing },
      thesis: { one_liner: synth.one_liner, long_form: synth.long_form, conviction: synth.conviction, key_debates: synth.key_debates, invalidation_triggers: synth.invalidation_triggers },
      verification: { confidence: research.verification.confidence, grounded_coverage: grounding.report.coverage },
      scenario_summary: scenarioSummary,
      market_context: mc ? JSON.stringify({ consensus: mc.consensus, analyst_view: mc.analyst_view }) : undefined,
      next_earnings_date: company.next_earnings_date,
      price_context: priceCtx?.ctx.ok ? {
        current_price: priceCtx.ctx.current_price,
        as_of: priceCtx.ctx.as_of,
        analyst_target: priceCtx.ctx.analyst_target,
        target_gap_pct: priceCtx.ctx.target_gap_pct,
        market_repriced: priceCtx.ctx.market_repriced,
        note: priceCtx.ctx.note,
      } : undefined,
    }).catch((e) => { console.warn(`[coverage] positioning failed: ${(e as Error).message}`); return null; });

    // Control P12: deterministic positioning readout — implied assumptions, an illustrative fair value
    // reconciled against the target/lean, and an action rule for every invalidation trigger. Spot is
    // best-effort from the latest price signal; degrades to null (no readout) when spot/scenario/target
    // are missing. Merged onto the decision before it is written to the snapshot content.
    if (positioning) {
      // Spot: prefer the verified live-price anchor fetched this pass; fall back to the latest
      // TradingView-fed signal_events price only when the price fetch degraded. Previously this read
      // signal_events alone, which is empty for research-only names → the readout silently degraded.
      let spot = priceCtx?.ctx.ok ? priceCtx.ctx.current_price : null;
      if (spot == null) {
        const spotRow = await query<{ price: number | null }>(
          `SELECT (payload->>'price')::float8 AS price FROM signal_events
            WHERE company_id = $1 AND payload ? 'price' ORDER BY ts DESC LIMIT 1`,
          [company.id],
        ).catch(() => ({ rows: [] as { price: number | null }[] }));
        spot = spotRow.rows[0]?.price ?? null;
      }
      const readout = positioningReadout({
        modelRatios: { gross_margin: model.ratios.gross_margin ?? null, net_margin: model.ratios.net_margin ?? null },
        scenarioBands: scenario ? { eps: scenario.bands.eps ?? null, revenue_growth: scenario.bands.revenue_growth ?? null } : null,
        priceTarget: positioning.price_target,
        spot,
        consensusMultiple: null,
        lean: positioning.strategic_stance,
        invalidationTriggers: positioning.invalidation_triggers,
        actionRules: positioning.action_rules,
      }, POSITIONING_CONFIG);
      if (readout) {
        positioning = { ...positioning, implied_assumptions: readout.implied_assumptions, fair_value: readout.fair_value, action_rules: readout.action_rules };
      }
    }
  }

  const asOf = opts.asOf ?? model.period_end ?? todayIso();
  const cycleLabel = `${opts.formType ?? "Filing"} ${model.fiscal_period ?? asOf}`;
  const snapshotId = randomUUID();

  // 4. Append the snapshot atomically with its source row (provenance for every line item).
  // Control P12: surface the filing source id to the outer scope so the post-commit read-through
  // enrichment can stamp source_ref on its edges (best-effort — the field is nullable).
  let filingSourceId: string | null = null;
  await withTransaction(async (client) => {
    const src = await client.query<{ id: string }>(
      `INSERT INTO sources (company_id, tier, kind, origin, url, title, retrieved_at, metadata)
       VALUES ($1, 1, 'filing', 'SEC EDGAR', $2, $3, now(), $4) RETURNING id`,
      [company.id, filingUrl ?? null, `${opts.formType ?? "Filing"} ${opts.accession}`, { accession: opts.accession }],
    );
    const sourceId = src.rows[0].id;
    filingSourceId = sourceId; // control P12: surfaced for post-commit read-through enrichment
    basisBlock.provenance = [{ claim_id: "basis", source_ref: sourceId }]; // control P11: stamp the filing

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

    // Verified live-price anchor gets its OWN Tier-2 source row (Yahoo), kept distinct from the filing
    // and the Perplexity market context. This is the timestamped quote the report anchors on + the
    // staleness signal — persisted so the diff, the UI, and any re-run can see what price it reasoned off.
    let priceContext: Record<string, unknown> | undefined;
    if (priceCtx?.ctx.ok) {
      const pcSrc = await client.query<{ id: string }>(
        `INSERT INTO sources (company_id, tier, kind, origin, url, title, retrieved_at, metadata)
         VALUES ($1, 2, 'api', 'Yahoo Finance', $2, $3, now(), $4) RETURNING id`,
        [company.id, priceCtx.url, `Price anchor ${company.primary_ticker}`, { as_of: priceCtx.ctx.as_of, retrieved_at: priceCtx.retrieved_at }],
      );
      priceContext = { ...priceCtx.ctx, provenance: [{ claim_id: "price_context", source_ref: pcSrc.rows[0].id }] };
    }

    const thesis = Thesis.parse({
      one_liner: synth.one_liner,
      long_form: `${synth.long_form}${synth.actual_vs_expected ? `\n\nActual vs expected: ${synth.actual_vs_expected}` : ""}`,
      tensions: synth.tensions,
      // Catalysts now come from the decision engine (was always []). Keep only clean ISO dates.
      catalysts: (positioning?.catalysts ?? []).map((c) => ({
        event: c.event,
        date: /^\d{4}-\d{2}-\d{2}$/.test(c.date ?? "") ? c.date : null,
        expected_impact: `${c.expected_direction}${c.why ? `: ${c.why}` : ""}`,
      })),
      invalidation_triggers: q.admitted,
      risks: p10Risks,           // control P10: typed risks (mechanism/severity/linked trigger)
      triggers: p10Triggers,     // control P10: typed invalidation triggers with verifiable disclosure
      conviction: synth.conviction,
      positions_held: (company.coverage?.positions_held as never[]) ?? [],
    });

    // The desk's work product: the panel contributions + the adversarial verification (confidence + gaps).
    const researchBlock = {
      panel: research.panel,
      verification: research.verification,
      grounding: grounding.report, // pipeline upgrade §2: grounded-coverage of the load-bearing claims
      deepening: research.deepening ?? null, // Workstream C escalation trace (for the report UI + chat)
      provenance: [{ claim_id: "research", source_ref: sourceId }],
    };

    // MD&A hypotheses (#3) + Monte Carlo scenario (#4), both provenance-stamped to the filing.
    const hypothesesBlock = drivers.length
      ? { as_of: new Date().toISOString(), filing_ref: opts.accession, drivers, provenance: [{ claim_id: "hypotheses", source_ref: sourceId }] }
      : undefined;
    const scenarioBlock = scenario
      ? { ...scenario, anchor: (mc?.consensus as Record<string, unknown> | null) ?? null, coherence, pbeat_divergence: pbeatDivergence, provenance: [{ claim_id: "scenario", source_ref: sourceId }] }
      : undefined;

    const content = {
      fundamentals: {
        statements: line_items,
        model,
        provenance: Object.keys(line_items).map((k) => ({ claim_id: `fundamentals.${k}`, source_ref: sourceId })),
      },
      ...(marketContext ? { market_context: marketContext } : {}),
      ...(priceContext ? { price_context: priceContext } : {}),
      ...(hypothesesBlock ? { hypotheses: hypothesesBlock } : {}),
      ...(scenarioBlock ? { scenario: scenarioBlock } : {}),
      ...(surprises.length ? { surprises } : {}),
      ...(synth.key_debates?.length ? { key_debates: synth.key_debates } : {}),
      levers, // ROE/DuPont + balance-sheet health, computed from XBRL (grounded to the filing)
      basis: basisBlock, // control P11: per-line-item basis + FCF bridge + GAAP/non-GAAP reconciliation
      data_integrity: integrity, // MU-audit P1: the accounting-identity gate's execution log for this snapshot
      coverage_scorecard: scorecard, // control P5: per-filing-type disclosure coverage (gaps + %-claim flags)
      trends, // W3: multi-year trend/cyclicality context from the filing series
      ...(consistency.length ? { consistency } : {}), // W6: claims that conflict with the computed figures
      ...(riskJoin.length ? { risk_join: riskJoin } : {}), // P10: risk<->trigger join findings (blocks hold auto-publish)
      ...(q.quarantined.length ? { provenance_audit: { quarantined_triggers: q.quarantined } } : {}), // P3: ungrounded currency triggers held out
      ...(demand ? { demand } : {}), // demand-side levers extracted from the primary filing text
      ...(positioning ? { positioning } : {}),
      research: researchBlock,
      thesis,
      events: {
        filings: [{ accession: opts.accession, form: opts.formType ?? null, url: filingUrl ?? null }],
        ...(releaseUrl ? { earnings_release: { url: releaseUrl, ingested: !!releaseText } } : {}),
        ...(transcriptMeta ? { transcript: transcriptMeta } : {}),
      },
    };

    await client.query(
      `INSERT INTO canonical_snapshots
         (snapshot_id, canonical_file_id, company_id, as_of, cycle_label, trigger, conviction, confidence, filing_ref, content, diff)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [snapshotId, cf.id, company.id, asOf, cycleLabel, trigger, synth.conviction, research.verification.confidence, opts.accession,
        JSON.stringify(content), JSON.stringify(diff)],
    );

    // Provenance (control P3): persist the verified located claims + extracted trigger tokens in the
    // SAME transaction as the snapshot append (after the snapshot row exists, so the FK holds), so the
    // numbers and their grounding commit atomically with the snapshot.
    if (PROVENANCE_CONFIG.enabled) {
      await persistNumericClaims(client, { snapshotId, companyId: company.id, sourceRef: sourceId, verified: verifiedClaims, triggerClaims: q });
    }
  });

  // 4b. Control P4 — claim dependency DAG. Build the fact->claim DAG for this snapshot, retract the
  // facts implicated by a hard accounting-identity failure (staling their claims), then propagate any
  // RESTATEMENT of a prior period's facts (same fact_key + same period diverging beyond tolerance, or a
  // vanished metric — a routine next-period filing never flags) to stale the prior claims that consumed
  // them. Best-effort AFTER the snapshot tx committed: it can never roll back the snapshot.
  const dag = await buildClaimDag(snapshotId).catch((e) => { console.warn(`[coverage] claim DAG build failed: ${(e as Error).message}`); return null; });
  if (CLAIM_DAG_CONFIG.retractOnIdentityHardFail && integrity.ok === false) {
    for (const metric of integritySuppressed) {
      await retractFact({ snapshotId, factKey: `fundamentals.${metric}`, reason: "accounting-identity hard failure" })
        .catch((e) => { console.warn(`[coverage] fact retraction failed: ${(e as Error).message}`); return 0; });
    }
  }
  const claimsStaleFlagged = await propagateRestatement(company.id, snapshotId)
    .catch((e) => { console.warn(`[coverage] restatement propagation failed: ${(e as Error).message}`); return 0; });

  // 5. Carry hypotheses into current_events (the next forward pass reads them); enrich links from html.
  if (drivers.length) {
    await query(
      "UPDATE canonical_files SET current_events = jsonb_set(current_events, '{hypotheses}', $2::jsonb) WHERE id = $1",
      [cf.id, JSON.stringify({ as_of: new Date().toISOString(), filing_ref: opts.accession, drivers, provenance: [] })],
    ).catch((e) => console.warn(`[coverage] hypotheses persist failed: ${(e as Error).message}`));
  }
  let linksEnriched = 0;
  let readThroughEdges = 0;
  if (html) {
    const enriched = await enrichLinks(opts, company, html, config, { snapshotId, sourceRef: filingSourceId, demand }).catch((e) => {
      console.warn(`[coverage] link enrichment failed: ${(e as Error).message}`);
      return { links: 0, readThrough: 0 };
    });
    linksEnriched = enriched.links;
    readThroughEdges = enriched.readThrough;
  }

  // 6. Read-through: the filing is the origin event; propagate to linked assets.
  let readThroughNotes = 0;
  if (opts.newsAnalyzer) {
    const rt = await propagateReadThrough(opts.newsAnalyzer, {
      noteId: snapshotId, companyId: company.id, companyName: company.legal_name,
      headline: `${company.legal_name} filed ${opts.formType ?? "a filing"}: ${synth.one_liner}`,
      summary: synth.actual_vs_expected || synth.one_liner, category: "guidance", sourceRef: null,
    }).catch((e) => { console.warn(`[coverage] read-through failed: ${(e as Error).message}`); return { notesCreated: 0, reached: [] }; });
    readThroughNotes = rt.notesCreated;
  }

  // 7. Adjudicate the open areas of interest: the desk resolves the ones this filing puts to bed
  // (invalidated / confirmed / overreaction) and carries the rest to next quarter.
  let areasResolved = 0;
  let areasCarried = 0;
  if (openAreas.length && panel.adjudicateAreas) {
    const adj = await panel.adjudicateAreas({
      company: { legal_name: company.legal_name, ticker: company.primary_ticker },
      thesis: synth, evidence,
      areas: openAreas.map((a) => ({ theme: a.theme, title: a.title, summary: a.summary, mentions: a.mentions })),
    }).catch((e) => { console.warn(`[coverage] area adjudication failed: ${(e as Error).message}`); return null; });
    if (adj) {
      const applied = await applyResolutions({
        companyId: company.id, accession: opts.accession, snapshotId,
        revisitAfter: company.next_earnings_date, resolutions: adj.resolutions,
      });
      areasResolved = applied.resolved;
      areasCarried = applied.carried;
    }
  }

  // 8. Auto-commit (Workstream C): the desk publishes what cleared the bar and enqueues the content
  // spider. Runs AFTER the snapshot tx has committed, so it never holds that tx open across enqueue.
  // Omitted (e.g. in fundamentals tests) → the asset is left as-is and the result carries defaults.
  const dp = research.deepening;
  // Publish gates on auto-commit: an ungrounded thesis (§2) AND a description-only decision (Doc 2 §6 —
  // no variant view or no catalysts) are both held for the human checkpoint, never auto-published.
  const positioningOk = positioning ? positioningComplete(positioning).complete : true;
  // A claim that contradicts the computed figures (W6) is a hard hold, like a standing contradiction.
  // A hard accounting-identity failure (MU-audit P1) is likewise never auto-published — held for review.
  // Staleness guard: when the market has repriced ahead of the frame's sell-side target, hold a
  // constructive/bullish call for the human checkpoint — the thesis may be anchored to a stale target.
  // An already-cautious/neutral/avoid stance is not inflated by a stale target, so it still auto-commits.
  const bullishStance = positioning ? ["strong_long", "constructive"].includes(positioning.strategic_stance) : false;
  const staleFrameHold = !!priceCtx?.ctx.stale_frame && bullishStance;
  if (staleFrameHold) console.warn(`[coverage] ${company.primary_ticker} held: market repriced ahead of frame (${positioning?.strategic_stance}) — routing to review`);
  const cleared = (dp ? dp.cleared : research.verification.recommendation !== "review") && !grounding.gated && positioningOk && consistency.length === 0 && integrity.ok && q.quarantined.length === 0 && (p10Triggers.length === 0 || blocks(riskJoin).length === 0) && scorecard.ok && !staleFrameHold;
  let committed = false;
  let publishedStatus = "in_research";
  let contentJobId: string | null = null;
  if (opts.autoCommit) {
    const ac = await opts.autoCommit({
      companyId: company.id, snapshotId, config: deskConfig,
      deepen: {
        cleared,
        publishedBelowBar: dp ? dp.published_below_bar : false,
        finalConfidence: research.verification.confidence,
        rounds: dp ? dp.rounds.length : 1,
        stoppedReason: dp ? dp.stopped_reason : (cleared ? "cleared" : "review"),
        noteLines: [synth.one_liner],
      },
    }).catch((e) => { console.warn(`[coverage] auto-commit failed: ${(e as Error).message}`); return null; });
    if (ac) { committed = ac.committed; publishedStatus = ac.status; contentJobId = ac.jobId; }
  }

  return {
    company_id: company.id, snapshot_id: snapshotId, as_of: asOf, cycle_label: cycleLabel,
    conviction: synth.conviction, metrics_extracted: Object.keys(line_items).length,
    missing_metrics: missing, links_enriched: linksEnriched, read_through_notes: readThroughNotes,
    read_through_relationships: readThroughEdges,
    drivers_extracted: drivers.length, scenario,
    confidence: research.verification.confidence,
    grounded_coverage: grounding.report.coverage,
    needs_review: research.verification.recommendation === "review",
    areas_addressed: openAreas.length, areas_resolved: areasResolved, areas_carried: areasCarried,
    committed, published_status: publishedStatus, content_job_id: contentJobId,
    deepen_rounds: dp ? dp.rounds.length : 0,
    claims_built: dag?.claims ?? 0, claims_stale_flagged: claimsStaleFlagged,
    coverage_gaps: scorecard.gaps.length, coverage_scorecard_ok: scorecard.ok,
  };
}

/** Assemble the evidence the analyst desk reasons over (figures are ground truth; the rest advisory). */
function buildEvidence(
  model: FinancialModel, diff: SnapshotDiff, drivers: Driver[], scenario: ScenarioOutput | null,
  mc: MarketContextData | null, openAreas: OpenArea[], filingLabel: string, surpriseBrief = "",
  pbeatNote: string | null = null,
): string {
  const b = (n: number) => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : `$${(n / 1e6).toFixed(0)}M`);
  // The surprise briefing leads: it must frame how the desk reads every figure below it.
  const lines: string[] = surpriseBrief ? [surpriseBrief, "", `Filing: ${filingLabel}.`] : [`Filing: ${filingLabel}.`];
  const li = Object.values(model.line_items).map((x) => `${x.label} ${x.unit === "USD/shares" ? x.value.toFixed(2) : b(x.value)}${x.yoy ? ` (YoY ${(x.yoy.change_pct * 100).toFixed(1)}%)` : ""}`);
  if (li.length) lines.push(`Figures (XBRL — ground truth): ${li.join("; ")}`);
  const ratios = Object.entries(model.ratios).map(([k, v]) => `${k.replace("_", " ")} ${(v * 100).toFixed(1)}%`);
  if (ratios.length) lines.push(`Margins: ${ratios.join(", ")}`);
  const ch = diff.metrics.filter((m) => m.change_pct != null).map((m) => `${m.label} ${m.direction} ${((m.change_pct as number) * 100).toFixed(1)}%`);
  if (ch.length) lines.push(`Change vs prior snapshot: ${ch.join(", ")}`);
  if (drivers.length) lines.push(`MD&A drivers: ${drivers.map((d) => `${d.name} (${d.metric}, ${d.direction})`).join("; ")}`);
  if (scenario?.bands?.revenue) lines.push(`Monte Carlo next period: revenue P10/P50/P90 ${b(scenario.bands.revenue.p10)}/${b(scenario.bands.revenue.p50)}/${b(scenario.bands.revenue.p90)}; P(beat rev) ${scenario.beat_probability.revenue ?? "—"}; top driver ${scenario.sensitivity[0]?.driver ?? "—"}${pbeatNote ? ` ${pbeatNote}` : ""}`);
  if (mc?.consensus) lines.push(`Consensus (Perplexity/Fiscal.ai): ${JSON.stringify(mc.consensus)}`);
  if (mc?.analyst_view) lines.push(`Analyst view: ${JSON.stringify(mc.analyst_view)}`);
  if (openAreas.length) {
    lines.push(`Open areas of interest to address (accumulated from the headlines since the last filing): ${openAreas.map((a) => `[${a.theme}] ${a.title}${a.mentions > 1 ? ` (×${a.mentions})` : ""}`).join("; ")}`);
  }
  return lines.join("\n");
}

/** Turn the reported model (+ prior snapshot + consensus) into surprise observations: YoY growth per
 *  line item, margin percentage-point moves vs the prior snapshot, and beats/misses vs consensus. */
function buildSurpriseObservations(
  model: FinancialModel,
  priorModel: FinancialModel | null,
  suppress: Set<string> = new Set(),
): Observation[] {
  const obs: Observation[] = [];

  for (const [key, li] of Object.entries(model.line_items)) {
    if (suppress.has(key)) continue; // identity-gate: don't investigate a figure known to be broken
    if (li.yoy && Number.isFinite(li.yoy.change_pct)) {
      const growth = li.yoy.change_pct;
      const priorYear = growth !== -1 ? li.value / (1 + growth) : 0;
      obs.push({ key: `yoy.${key}`, label: `${li.label} YoY`, current: li.value, baseline: priorYear, baselineSource: "prior-year (XBRL)", kind: "yoy_growth", unit: li.unit });
    }
  }

  if (priorModel?.ratios) {
    for (const rk of ["gross_margin", "operating_margin", "net_margin"]) {
      const cur = model.ratios[rk];
      const pr = priorModel.ratios[rk];
      if (cur != null && pr != null) {
        obs.push({ key: `margin.${rk}`, label: rk.replace("_", " "), current: cur, baseline: pr, baselineSource: "prior snapshot", kind: "margin_pp", unit: "ratio" });
      }
    }
  }

  // NOTE: no consensus beat/miss surprise here. The consensus we fetch is the NEXT-quarter estimate
  // (Perplexity: "consensus for the NEXT quarter"), so comparing it to the JUST-REPORTED quarter is
  // period-mismatched and produced a spurious "miss" (e.g. reported Q3 $41.5B vs next-quarter $50.76B
  // read as -18%). A real beat/miss needs the same-period estimate, which we don't reliably have; the
  // forward consensus is used correctly downstream as the next-period bar (scenario + positioning).

  return obs;
}

/** Build the Monte Carlo next-period scenario from MD&A drivers + XBRL history + consensus. */
function buildScenario(
  facts: CompanyFacts,
  model: FinancialModel,
  drivers: Driver[],
  consensus: unknown,
  company: CompanyRow,
  config: FundamentalsConfig,
  rng?: () => number,
): ScenarioOutput | null {
  if (!drivers.length) return null;
  const base = priorYearBaseForNext(facts, "revenue", model.period_end ?? todayIso(), config);
  const ni = model.line_items.net_income?.value;
  const rev = model.line_items.revenue?.value;
  const epsD = model.line_items.eps_diluted?.value;
  const netMargin = model.ratios.net_margin ?? (ni && rev ? ni / rev : undefined);
  if (!base || netMargin == null) return null;
  return simulateScenario({
    drivers,
    revenue_prior_year: base.value,
    base_period: base.period_end,
    target_period: company.next_earnings_date ?? null,
    net_margin: netMargin,
    shares: epsD && epsD !== 0 && ni ? ni / epsD : null,
    revenue_growth: stats(metricYoYGrowths(facts, "revenue", config)),
    net_margin_stdev: stats(netMarginLevels(facts, config)).stdev,
    consensus: consensus as { revenue_estimate_usd?: number | null; eps_estimate?: number | null } | null,
    runs: config.montecarlo.runs,
    boundSigma: config.montecarlo.boundSigma,
    sensitivityTopN: config.montecarlo.sensitivityTopN,
    rng: rng ?? mulberry32(config.montecarlo.seed),
  });
}

/**
 * Read named counterparties out of the filing. Covered counterparties (already in our universe) become
 * company_links edges as before; UNCOVERED ones — plus the demand-side customers extracted from the
 * filing text — are recorded as read_through_relationships so the relationship graph is no longer empty
 * for names we don't yet cover (control P12). When a counterparty later becomes covered, its earlier
 * uncovered edge is pointed at the covered company; the covered company_links edge is preferred on
 * de-dupe. Returns the count of company_links created + read-through edges upserted.
 */
async function enrichLinks(
  opts: { accession: string; formType?: string | null; analyst: FundamentalsAnalyst },
  company: CompanyRow,
  html: string,
  config: FundamentalsConfig,
  ctx: { snapshotId: string; sourceRef: string | null; demand: DemandProfile | null },
): Promise<{ links: number; readThrough: number }> {
  const client = getPool();
  let links = 0;
  let readThrough = 0;

  const text = concentrationExcerpt(html, config.linkTextBudget);
  if (text) {
    const extracted = await opts.analyst.extractLinks({
      company: { legal_name: company.legal_name, ticker: company.primary_ticker },
      filing: { form: opts.formType ?? "Filing" }, text,
    });

    for (const link of extracted.links) {
      // Match only to companies ALREADY covered — never auto-create (that is Ingestion's job).
      const match = await query<{ id: string; gics_sector: string | null }>(
        `SELECT id, gics_sector FROM companies
          WHERE ($1::text IS NOT NULL AND upper(primary_ticker) = upper($1))
             OR lower(legal_name) = lower($2) LIMIT 1`,
        [link.ticker, link.name],
      );
      const to = match.rows[0];
      if (to && to.id === company.id) continue; // self-reference

      if (to) {
        // Covered → company_links (unchanged). Prefer this edge; point any earlier uncovered
        // read-through edge for the same counterparty at the now-covered company.
        const crossSector = !!company.gics_sector && !!to.gics_sector && company.gics_sector !== to.gics_sector;
        const res = await query(
          `INSERT INTO company_links (from_company_id, to_company_id, type, cross_sector, strength, direction_note, rationale, status)
           VALUES ($1,$2,$3,$4,'medium',$5,$6,'unverified')
           ON CONFLICT (from_company_id, to_company_id, type) DO NOTHING`,
          [company.id, to.id, link.type, crossSector, `from ${opts.formType ?? "filing"} ${opts.accession}`, link.rationale],
        );
        links += res.rowCount ?? 0;
        await linkReadThroughMatch(client, company.id, link.name, to.id).catch(() => 0);
      } else {
        // Uncovered → record a read-through relationship edge.
        readThrough += await upsertReadThrough(client, {
          companyId: company.id, snapshotId: ctx.snapshotId, counterpartyName: link.name, ticker: link.ticker,
          type: link.type, materiality: link.materiality, rationale: link.rationale, readThrough: link.rationale,
          sourceRef: ctx.sourceRef,
        });
      }
    }
  }

  // Additionally: map the demand-side customers extracted from the filing to customer-type edges.
  for (const cust of ctx.demand?.customers ?? []) {
    const match = await query<{ id: string }>(
      "SELECT id FROM companies WHERE lower(legal_name) = lower($1) LIMIT 1", [cust.name],
    );
    const toId = match.rows[0]?.id && match.rows[0].id !== company.id ? match.rows[0].id : null;
    const readThroughNote = cust.relationship || cust.note || (cust.share_pct != null ? `~${cust.share_pct}% of revenue` : "named customer");
    const materiality = cust.reliability === "at_risk" ? "high" : (cust.share_pct != null && cust.share_pct >= 10) ? "high" : "medium";
    readThrough += await upsertReadThrough(client, {
      companyId: company.id, snapshotId: ctx.snapshotId, counterpartyName: cust.name, ticker: null,
      type: "customer", materiality, rationale: cust.note || cust.relationship || "disclosed customer",
      readThrough: readThroughNote, toCompanyId: toId, sourceRef: ctx.sourceRef,
    });
  }

  return { links, readThrough };
}
