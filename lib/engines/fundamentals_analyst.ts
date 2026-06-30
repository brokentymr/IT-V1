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

export interface FundamentalsAnalyst {
  frameForward(input: ForwardFrameInput): Promise<ForwardFrame>;
  draftThesis(input: ThesisDraftInput): Promise<ThesisDraft>;
  extractLinks(input: LinkExtractInput): Promise<LinkExtractResult>;
  extractDrivers(input: DriverExtractInput): Promise<DriversResult>;
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
}
