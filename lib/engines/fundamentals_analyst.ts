/**
 * The LLM judgment surface for Engine 2 (Fundamental Research). Defined as an interface so the
 * engine is deterministic to test (inject a fake) and the eval harness scores the real Claude
 * analyst. The MATH never lives here — figures are computed in lib/financials/model.ts; this
 * surface only frames the forward view, narrates the thesis over the figures, and reads named
 * relationships out of filing text. Model resolved by the client (Haiku under LLM_MODEL_OVERRIDE).
 */
import { z } from "zod";
import { completeJSON } from "../llm/client";
import { LinkType, Driver } from "../types";
import type { FinancialModel, SnapshotDiff } from "../financials/model";

/** Optional external factual context (Perplexity/Fiscal.ai), passed verbatim into prompts. */
export interface MarketContextInput {
  consensus?: unknown;
  analyst_view?: unknown;
}
const ctxLine = (label: string, ctx?: MarketContextInput): string =>
  ctx && (ctx.consensus || ctx.analyst_view)
    ? `\n${label} (external, advisory — do NOT treat as ground-truth numbers):\n  consensus: ${JSON.stringify(ctx.consensus ?? null)}\n  analyst view: ${JSON.stringify(ctx.analyst_view ?? null)}`
    : "";

/**
 * Operator-specified research factors to give EXTRA WEIGHT (intake directives). These are an added
 * emphasis layered on top of the full analysis — they must NOT narrow it or cost breadth.
 */
const focusLine = (focus?: string[]): string =>
  focus?.length
    ? `\n\nAdded emphasis (do NOT narrow the analysis — keep full breadth): in addition to complete standard coverage, give extra weight to and explicitly address ${focus.map((f) => `"${f}"`).join(", ")}, with both the quantitative and qualitative read, flagging anything here that could materially change the outlook (e.g. demand destruction, share shift). Treat these as priority topics layered on top, not a replacement for comprehensive analysis.`
    : "";

// ---------- forward pass ----------
export interface ForwardFrameInput {
  company: { legal_name: string; ticker: string; gics_sector: string | null };
  next_earnings_date: string | null;
  rolling_outlook: string;
  standing_model: Pick<FinancialModel, "fiscal_period" | "ratios"> & { headline: Record<string, number> };
  market_context?: MarketContextInput;
}

export const ForwardFrame = z.object({
  expectations: z.string(),
  focus_metrics: z.array(z.string()).default([]),
  confirm_conditions: z.array(z.string()).default([]),
  break_conditions: z.array(z.string()).default([]),
});
export type ForwardFrame = z.infer<typeof ForwardFrame>;

// ---------- coverage pass (thesis) ----------
export interface ThesisDraftInput {
  company: { legal_name: string; ticker: string; gics_sector: string | null };
  filing: { form: string; accession: string; period: string | null };
  model: FinancialModel;
  diff: SnapshotDiff;
  rolling_outlook: string;
  forward_expectations: string | null; // from the forward note, if one was staged
  market_context?: MarketContextInput;
  research_focus?: string[];
}

export const ThesisDraft = z.object({
  one_liner: z.string(),
  long_form: z.string(),
  actual_vs_expected: z.string(),
  tensions: z.array(z.string()).default([]),
  invalidation_triggers: z.array(z.string()).min(1), // must be present + specific (eval scores this)
  conviction: z.number().int().min(1).max(5),
});
export type ThesisDraft = z.infer<typeof ThesisDraft>;

// ---------- link enrichment ----------
export interface LinkExtractInput {
  company: { legal_name: string; ticker: string };
  filing: { form: string };
  text: string; // bounded slice of the filing around concentration/relationship language
}

export const ExtractedLink = z.object({
  name: z.string(),
  ticker: z.string().nullable(),
  type: LinkType,
  materiality: z.enum(["low", "medium", "high"]),
  rationale: z.string(),
});
export const LinkExtractResult = z.object({ links: z.array(ExtractedLink).default([]) });
export type ExtractedLink = z.infer<typeof ExtractedLink>;
export type LinkExtractResult = z.infer<typeof LinkExtractResult>;

// ---------- MD&A driver extraction (Phase-4 improvement #3) ----------
export interface DriverExtractInput {
  company: { legal_name: string; ticker: string };
  filing: { form: string };
  mda_text: string; // bounded MD&A slice
  research_focus?: string[];
}
export const DriversResult = z.object({ drivers: z.array(Driver).default([]) });
export type DriversResult = z.infer<typeof DriversResult>;

// ---------- Demand / supply extraction (grounding upgrade: the demand-side levers) ----------
export const CustomerNote = z.object({
  name: z.string(),
  share_pct: z.number().nullable().default(null), // % of revenue, if disclosed
  relationship: z.string().default(""), // what they buy / the nature of the relationship
  reliability: z.enum(["reliable", "cyclical", "at_risk", "unknown"]).default("unknown"),
  note: z.string().default(""),
});
export const DemandProfile = z.object({
  customers: z.array(CustomerNote).default([]),
  customer_concentration: z.string().default(""), // e.g. "top 3 ≈ 45% of revenue" or "none disclosed"
  segments: z.array(z.object({ name: z.string(), revenue_share_pct: z.number().nullable().default(null), trend: z.string().default("") })).default([]),
  geographic: z.array(z.object({ region: z.string(), revenue_share_pct: z.number().nullable().default(null) })).default([]),
  demand_signals: z.string().default(""), // orders / backlog / bookings / sell-through
  supply_constraints: z.string().default(""), // capacity / lead-time / allocation
});
export type DemandProfile = z.infer<typeof DemandProfile>;

export interface DemandExtractInput {
  company: { legal_name: string; ticker: string };
  filing: { form: string };
  text: string; // customer-concentration + MD&A excerpts from the filing
}

/** Plain, citable evidence block for the desk — demand-side facts sourced from the filing text. */
export function demandBriefing(d: DemandProfile): string {
  const parts: string[] = [];
  if (d.customer_concentration) parts.push(`Customer concentration: ${d.customer_concentration}.`);
  if (d.customers.length) parts.push(`Key customers: ${d.customers.map((c) => `${c.name}${c.share_pct != null ? ` (${c.share_pct}%)` : ""}${c.reliability !== "unknown" ? ` [${c.reliability}]` : ""}`).join("; ")}.`);
  if (d.segments.length) parts.push(`Segments: ${d.segments.map((s) => `${s.name}${s.revenue_share_pct != null ? ` ${s.revenue_share_pct}%` : ""}${s.trend ? ` (${s.trend})` : ""}`).join("; ")}.`);
  if (d.geographic.length) parts.push(`Geography: ${d.geographic.map((g) => `${g.region}${g.revenue_share_pct != null ? ` ${g.revenue_share_pct}%` : ""}`).join("; ")}.`);
  if (d.demand_signals) parts.push(`Demand signals: ${d.demand_signals}`);
  if (d.supply_constraints) parts.push(`Supply constraints: ${d.supply_constraints}`);
  return parts.length ? `Demand & supply (from the filing — ground truth):\n${parts.map((p) => `- ${p}`).join("\n")}` : "";
}

// ---------- Non-GAAP reconciliation (control P11: basis labeling) ----------
// The non-GAAP figures a filing discloses alongside GAAP (from its reconciliation table). Margins are
// FRACTIONS (0..1) to align with model.ratios. Absent disclosures degrade to null — never fabricated.
export const NonGaapReconciliation = z.object({
  eps: z.number().nullable().default(null),            // non-GAAP diluted EPS, dollars/share
  gross_margin: z.number().nullable().default(null),   // fraction 0..1
  operating_margin: z.number().nullable().default(null),
  net_margin: z.number().nullable().default(null),
  label: z.string().default("non-GAAP (company adjusted)"),
});
export type NonGaapReconciliation = z.infer<typeof NonGaapReconciliation>;

export interface NonGaapExtractInput {
  company: { legal_name: string; ticker: string };
  filing: { form: string };
  text: string; // the non-GAAP reconciliation / adjusted-results excerpt from the filing
}

export interface FundamentalsAnalyst {
  frameForward(input: ForwardFrameInput): Promise<ForwardFrame>;
  draftThesis(input: ThesisDraftInput): Promise<ThesisDraft>;
  extractLinks(input: LinkExtractInput): Promise<LinkExtractResult>;
  extractDrivers(input: DriverExtractInput): Promise<DriversResult>;
  /** Optional so existing fakes keep working; coverage skips the demand step when absent. */
  extractDemand?(input: DemandExtractInput): Promise<DemandProfile>;
  /** Optional (control P11): pull the non-GAAP figures the filing reconciles to GAAP. Tests omit it. */
  extractNonGaap?(input: NonGaapExtractInput): Promise<NonGaapReconciliation>;
}

function headline(model: FinancialModel): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of ["revenue", "net_income", "operating_income", "eps_diluted"]) {
    if (model.line_items[k]) out[k] = model.line_items[k].value;
  }
  return out;
}

/** Compact figures the LLM narrates over (keeps prompts cheap + grounded). */
function modelDigest(model: FinancialModel, diff: SnapshotDiff): string {
  const lines = Object.values(model.line_items).map((li) => {
    const yoy = li.yoy ? ` (YoY ${(li.yoy.change_pct * 100).toFixed(1)}%)` : "";
    return `  ${li.label}: ${li.value.toLocaleString()} ${li.unit}${yoy} [${li.fp ?? "?"} ${li.period_end}]`;
  });
  const ratios = Object.entries(model.ratios).map(([k, v]) => `  ${k}: ${(v * 100).toFixed(1)}%`);
  const changes = diff.metrics
    .filter((m) => m.change_pct != null)
    .map((m) => `  ${m.label}: ${m.direction} ${((m.change_pct as number) * 100).toFixed(1)}% vs prior snapshot`);
  return [
    `Line items (period ${model.fiscal_period ?? "?"}):`, ...lines,
    "Margins:", ...(ratios.length ? ratios : ["  (none computable)"]),
    "Change vs prior snapshot:", ...(changes.length ? changes : ["  (no prior snapshot)"]),
  ].join("\n");
}

export class ClaudeFundamentalsAnalyst implements FundamentalsAnalyst {
  async frameForward(input: ForwardFrameInput): Promise<ForwardFrame> {
    const { company, standing_model } = input;
    const prompt = `You are a buy-side fundamental analyst staging the FORWARD view ahead of a filing.

Company: ${company.legal_name} (${company.ticker}) — GICS sector: ${company.gics_sector ?? "unknown"}.
Next filing/earnings date: ${input.next_earnings_date ?? "unknown"}.
Current rolling outlook: ${input.rolling_outlook || "(none yet)"}
Most recent reported standing: period ${standing_model.fiscal_period ?? "?"}, headline ${JSON.stringify(standing_model.headline)}, margins ${JSON.stringify(standing_model.ratios)}.${ctxLine("Market expectations", input.market_context)}

Frame what to expect from the upcoming print: what the market expects, what this filing needs to show,
and the SPECIFIC conditions that would confirm vs break the current thesis. Return JSON:
{"expectations": string, "focus_metrics": [string], "confirm_conditions": [string], "break_conditions": [string]}`;
    return completeJSON({ prompt, schema: ForwardFrame, model: "claude-sonnet-4-6", purpose: "fundamentals.forward", maxTokens: 1000 });
  }

  async draftThesis(input: ThesisDraftInput): Promise<ThesisDraft> {
    const { company, filing } = input;
    const prompt = `You are a buy-side fundamental analyst writing the COVERAGE thesis after a filing landed.

Company: ${company.legal_name} (${company.ticker}) — GICS sector: ${company.gics_sector ?? "unknown"}.
Filing: ${filing.form} ${filing.accession} (period ${filing.period ?? "?"}).
Rolling outlook coming in: ${input.rolling_outlook || "(none)"}
Forward expectations we staged: ${input.forward_expectations ?? "(no forward note)"}

Figures (computed from XBRL — treat as ground truth, do not recompute):
${modelDigest(input.model, input.diff)}${ctxLine("Market context", input.market_context)}

Write the thesis. Measure actual vs the forward expectations. Be concrete but CONCISE — keep
long_form to 3-5 sentences and each list to at most 4 short items. The invalidation triggers MUST be
specific and measurable (name a metric and a level/direction), not vague.${focusLine(input.research_focus)} Return JSON:
{"one_liner": string, "long_form": string, "actual_vs_expected": string, "tensions": [string],
 "invalidation_triggers": [string], "conviction": int 1-5}`;
    return completeJSON({ prompt, schema: ThesisDraft, model: "claude-sonnet-4-6", purpose: "fundamentals.thesis", maxTokens: 1600 });
  }

  async extractLinks(input: LinkExtractInput): Promise<LinkExtractResult> {
    const prompt = `Extract named business relationships from this ${input.filing.form} excerpt for ${input.company.legal_name} (${input.company.ticker}).

Only return relationships explicitly named in the text — customers, suppliers, partners, parents,
subsidiaries, competitors, or material customer/supplier concentrations. Do NOT invent names. If the
excerpt names no specific counterparties, return an empty list. Return JSON:
{"links": [{"name": string, "ticker": string|null,
  "type": "competitor|supplier|customer|parent|subsidiary|jv_partner|shared_end_market|thematic_peer|macro_correlated",
  "materiality": "low|medium|high", "rationale": string}]}

Excerpt:
${input.text}`;
    return completeJSON({ prompt, schema: LinkExtractResult, model: "claude-sonnet-4-6", purpose: "fundamentals.links", maxTokens: 1000 });
  }

  async extractDrivers(input: DriverExtractInput): Promise<DriversResult> {
    const prompt = `Read this ${input.filing.form} MD&A excerpt for ${input.company.legal_name} (${input.company.ticker}) and extract the 3-6 most material business drivers management discusses.

For each driver, map it to ONE metric it most affects: revenue | gross_margin | operating_margin | net_margin | net_income | eps. Give management's framing, a short grounding quote from the text, and a bear/base/bull IMPACT as SIGNED PERCENTAGE POINTS:
  - for "revenue": percentage points added to/subtracted from next-period YoY revenue growth.
  - for a margin metric: percentage points added to/subtracted from that margin LEVEL.
Bear = the unfavorable case, bull = the favorable case, base = most likely. A headwind has negative
base; a tailwind positive. Keep magnitudes realistic (most single drivers move a metric by 0-5 pts).
Only extract drivers grounded in the text — do NOT invent.${focusLine(input.research_focus)} Return JSON:
{"drivers": [{"name": string, "metric": <enum>, "direction": "tailwind|headwind|mixed",
  "framing": string, "quote": string|null,
  "impact_pct": {"bear": number, "base": number, "bull": number}}]}

MD&A excerpt:
${input.mda_text}`;
    return completeJSON({ prompt, schema: DriversResult, model: "claude-sonnet-4-6", purpose: "fundamentals.drivers", maxTokens: 1600 });
  }

  async extractDemand(input: DemandExtractInput): Promise<DemandProfile> {
    const prompt = `Read this ${input.filing.form} excerpt for ${input.company.legal_name} (${input.company.ticker}) and extract the DEMAND-SIDE picture — the supply/demand levers a buy-side analyst needs.

Extract ONLY what the text states or clearly supports; do NOT invent names, customers, or figures. Leave fields empty when the text is silent.
- customers: named customers and, if disclosed, their % of revenue and what they buy. Judge reliability from the text: "reliable" (diversified/contracted/sticky), "cyclical" (tied to a capex cycle, e.g. hyperscaler AI spend), "at_risk" (single-customer dependency, losing a program, concentration risk), or "unknown".
- customer_concentration: the disclosed concentration (e.g. "one customer >10% of revenue", "top 5 ≈ X%") or "none disclosed".
- segments / geographic: revenue mix by segment and region with % where given, plus the trend.
- demand_signals: orders, backlog, bookings, sell-through, or contracted/sold-out commentary.
- supply_constraints: capacity, lead-time, allocation, or utilization commentary.

Return JSON:
{"customers": [{"name": string, "share_pct": number|null, "relationship": string, "reliability": "reliable|cyclical|at_risk|unknown", "note": string}],
 "customer_concentration": string, "segments": [{"name": string, "revenue_share_pct": number|null, "trend": string}],
 "geographic": [{"region": string, "revenue_share_pct": number|null}], "demand_signals": string, "supply_constraints": string}

Excerpt:
${input.text}`;
    return completeJSON({ prompt, schema: DemandProfile, model: "claude-sonnet-4-6", purpose: "fundamentals.demand", maxTokens: 2000 });
  }

  async extractNonGaap(input: NonGaapExtractInput): Promise<NonGaapReconciliation> {
    const prompt = `Read this ${input.filing.form} excerpt for ${input.company.legal_name} (${input.company.ticker}) and extract the company's NON-GAAP (adjusted) figures where it reconciles them to GAAP.

Extract ONLY figures the text states; do NOT invent or recompute. Leave a field null when the text does not disclose a non-GAAP value for it.
- eps: non-GAAP / adjusted DILUTED earnings per share, in dollars per share.
- gross_margin / operating_margin / net_margin: the non-GAAP / adjusted margin, expressed as a FRACTION (e.g. 42.5% → 0.425).
- label: how the company names this basis (e.g. "non-GAAP", "Adjusted", "Adjusted (excluding stock-based compensation)").

Return JSON:
{"eps": number|null, "gross_margin": number|null, "operating_margin": number|null, "net_margin": number|null, "label": string}

Excerpt:
${input.text}`;
    return completeJSON({ prompt, schema: NonGaapReconciliation, model: "claude-sonnet-4-6", purpose: "fundamentals.nongaap", maxTokens: 800 });
  }
}
