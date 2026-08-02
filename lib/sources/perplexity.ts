/**
 * Perplexity (Sonar) — the keyed factual-lookup layer for Engine 2 (owner decision 2026-06-30).
 * Perplexity Finance is Fiscal.ai-backed (real-time SEC-filing financials, adjusted metrics,
 * beats/misses vs estimates), so this single source covers what we'd otherwise pull from
 * Fiscal.ai/Morningstar: forward earnings dates, consensus/estimates, and analyst/fair-value views.
 *
 * DISCIPLINE: advisory only. The deterministic XBRL model (lib/financials/model.ts) stays the
 * source of truth for modeled numbers; Perplexity output is provenance-stamped context + cross-check,
 * never silently fed into the math. Every call is cost-stamped into llm_usage and respects
 * MONTHLY_SPEND_CEILING_USD; failures degrade (ok=false) rather than throw (spec §8).
 */
import { z, type ZodType } from "zod";
import { query } from "../db/pool";
import { llmSpendThisMonth } from "../llm/client";
import type { SourceResult, ProvenanceStamp } from "./types";

const ENDPOINT = "https://api.perplexity.ai/chat/completions";
const ORIGIN = "Perplexity (Fiscal.ai)";
const model = (): string => process.env.PERPLEXITY_MODEL || "sonar";
const TIMEOUT_MS = Number(process.env.PERPLEXITY_TIMEOUT_MS ?? 20_000);

export interface PerplexityFetcher {
  (body: object): Promise<{ status: number; body: PerplexityResponse | null }>;
}

interface PerplexityResponse {
  choices?: Array<{ message?: { content?: string } }>;
  citations?: string[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: { total_cost?: number } };
}

/** Live Sonar fetcher (Bearer auth + timeout). */
export const livePerplexityFetcher: PerplexityFetcher = async (body) => {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return { status: 401, body: null };
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = res.ok ? ((await res.json()) as PerplexityResponse) : null;
  return { status: res.status, body: json };
};

/** Strip Sonar's inline citation markers ([1][2]) so the content parses as clean JSON. */
function stripCitations(s: string): string {
  return s.replace(/\[\d+\]/g, "");
}
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const s = stripCitations(fenced ? fenced[1] : text);
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  return start >= 0 && end > start ? s.slice(start, end + 1) : s;
}

export interface TextAnswer { ok: boolean; text: string; citations: string[]; missing: string[]; error?: string }

export class PerplexityClient {
  constructor(private readonly fetchChat: PerplexityFetcher = livePerplexityFetcher) {}

  /** Core call: key + ceiling guard, fetch, cost-stamp, return raw text + citations (degrades). */
  async askText(opts: { question: string; system?: string; maxTokens?: number; purpose?: string }): Promise<TextAnswer> {
    if (!process.env.PERPLEXITY_API_KEY) return { ok: false, text: "", citations: [], missing: ["PERPLEXITY_API_KEY not set"] };

    const ceiling = Number(process.env.MONTHLY_SPEND_CEILING_USD ?? 0);
    if (ceiling > 0 && (await llmSpendThisMonth()) >= ceiling) {
      return { ok: false, text: "", citations: [], missing: [`monthly spend ceiling reached ($${ceiling})`] };
    }

    try {
      const messages = opts.system
        ? [{ role: "system", content: opts.system }, { role: "user", content: opts.question }]
        : [{ role: "user", content: opts.question }];
      const { status, body } = await this.fetchChat({ model: model(), max_tokens: opts.maxTokens ?? 600, messages });
      if (status !== 200 || !body) return { ok: false, text: "", citations: [], missing: [`Perplexity HTTP ${status}`] };

      // Cost: Perplexity returns the exact per-request cost; record it in the shared ledger.
      const cost = body.usage?.cost?.total_cost ?? 0;
      await query(
        "INSERT INTO llm_usage (model, purpose, input_tokens, output_tokens, cost_usd) VALUES ($1,$2,$3,$4,$5)",
        [`perplexity:${model()}`, opts.purpose ?? "perplexity", body.usage?.prompt_tokens ?? 0, body.usage?.completion_tokens ?? 0, cost],
      ).catch(() => {});

      return { ok: true, text: (body.choices?.[0]?.message?.content ?? "").trim(), citations: body.citations ?? [], missing: [] };
    } catch (err) {
      return { ok: false, text: "", citations: [], missing: ["Perplexity unreachable"], error: (err as Error).message };
    }
  }

  /** Ask for a structured JSON answer and validate it; degrade (ok=false) on any failure. */
  async askJSON<T>(opts: {
    question: string;
    schema: ZodType<T>;
    system?: string;
    maxTokens?: number;
    purpose?: string;
  }): Promise<{ ok: boolean; data: T | null; citations: string[]; missing: string[]; error?: string }> {
    const system =
      (opts.system ? `${opts.system}\n\n` : "You answer with verified, up-to-date financial facts. ") +
      "Respond with ONLY a single valid JSON object — no prose, no markdown, no citation markers.";
    const r = await this.askText({ question: opts.question, system, maxTokens: opts.maxTokens, purpose: opts.purpose });
    if (!r.ok) return { ok: false, data: null, citations: r.citations, missing: r.missing, error: r.error };
    try {
      return { ok: true, data: opts.schema.parse(JSON.parse(extractJson(r.text))), citations: r.citations, missing: [] };
    } catch (err) {
      return { ok: false, data: null, citations: r.citations, missing: ["Perplexity answer did not parse"], error: (err as Error).message };
    }
  }
}

// ---------------------------------------------------------------------------
// Finance adapter — the methods Engine 2 calls.
// ---------------------------------------------------------------------------
export const ConsensusSchema = z.object({
  period: z.string().nullable(),
  revenue_estimate_usd: z.number().nullable(),
  eps_estimate: z.number().nullable(),
  last_result: z.string().nullable(),    // most recent beat/miss vs estimate, if known
  summary: z.string(),
});
export type Consensus = z.infer<typeof ConsensusSchema>;

export const AnalystViewSchema = z.object({
  fair_value_usd: z.number().nullable(),
  price_target_usd: z.number().nullable(),
  rating: z.string().nullable(),         // e.g. buy/hold/sell or star rating
  economic_moat: z.string().nullable(),  // Morningstar-style: none/narrow/wide
  // Best-effort recency stamp on the consensus target: when the desk knows a target is months old it
  // can weigh a large price-to-target gap as a possible pending downgrade rather than a live dislocation.
  target_as_of: z.string().nullable().default(null), // ISO date the target was last set/updated, if known
  summary: z.string(),
});
export type AnalystView = z.infer<typeof AnalystViewSchema>;

function stamp(citations: string[]): ProvenanceStamp {
  return { origin: ORIGIN, url: citations[0] ?? ENDPOINT, retrieved_at: new Date().toISOString() };
}

export class PerplexityFinance {
  constructor(private readonly client: PerplexityClient = new PerplexityClient()) {}

  /**
   * Next scheduled earnings/report date (SourceResult → plugs into resolveNextEarningsDate).
   * Uses a TEXT ask (not JSON): under a strict "JSON only" instruction Sonar suppresses its
   * calendar search and returns null, whereas a plain question reliably surfaces the date.
   */
  async nextEarningsDate(ticker: string, today: string): Promise<SourceResult<string | null>> {
    const r = await this.client.askText({
      question: `What is ${ticker}'s next scheduled quarterly earnings date after ${today}? Reply with only the date in YYYY-MM-DD format.`,
      maxTokens: 120, purpose: "perplexity.earnings_date",
    });
    const m = r.text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    const date = m && m[1] > today ? m[1] : null; // require a future date
    return { ok: r.ok && !!date, data: date, missing: date ? [] : r.missing, provenance: stamp(r.citations), error: r.error };
  }

  /** Analyst consensus / estimates (the forward-pass "what the market expects" baseline). */
  async consensus(ticker: string): Promise<SourceResult<Consensus>> {
    const r = await this.client.askJSON({
      question: `For ${ticker}, give current Wall Street consensus for the NEXT quarter: revenue estimate (USD), EPS estimate, the period, and the most recent quarter's beat/miss vs estimates. Return JSON {"period": string|null, "revenue_estimate_usd": number|null, "eps_estimate": number|null, "last_result": string|null, "summary": string}.`,
      schema: ConsensusSchema, maxTokens: 500, purpose: "perplexity.consensus",
    });
    return { ok: r.ok, data: r.data, missing: r.missing, provenance: stamp(r.citations), error: r.error };
  }

  /** Analyst / fair-value view (covers the Morningstar-style data: fair value, rating, moat). */
  async analystView(ticker: string): Promise<SourceResult<AnalystView>> {
    const r = await this.client.askJSON({
      question: `For ${ticker}, summarize the current sell-side / Morningstar-style view: fair value estimate (USD), average price target (USD), the date that consensus price target was most recently set or updated (ISO YYYY-MM-DD, null if unknown), consensus rating, and economic moat (none/narrow/wide). Return JSON {"fair_value_usd": number|null, "price_target_usd": number|null, "target_as_of": string|null, "rating": string|null, "economic_moat": string|null, "summary": string}.`,
      schema: AnalystViewSchema, maxTokens: 500, purpose: "perplexity.analyst",
    });
    return { ok: r.ok, data: r.data, missing: r.missing, provenance: stamp(r.citations), error: r.error };
  }
}
