/**
 * Claude API client with structured (JSON) output + a cost ledger and ceiling guard.
 * Model tiering per ARCHITECTURE §7.1; LLM_MODEL_OVERRIDE forces a single model (testing).
 * Every call records tokens + estimated USD to llm_usage; calls are refused once the
 * monthly spend reaches MONTHLY_SPEND_CEILING_USD (spec §1.2 cost discipline).
 */
import type { ZodType } from "zod";
import { query } from "../db/pool";

const PRICING: Record<string, { in: number; out: number }> = {
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

function priceFor(model: string): { in: number; out: number } {
  for (const k of Object.keys(PRICING)) if (model.startsWith(k)) return PRICING[k];
  return { in: 1, out: 5 };
}

/** Resolve the model: LLM_MODEL_OVERRIDE wins (testing), else the per-call tier, else Haiku. */
export function resolveModel(requested?: string): string {
  return process.env.LLM_MODEL_OVERRIDE || requested || "claude-haiku-4-5";
}

export class CostCeilingError extends Error {}

export async function llmSpendThisMonth(): Promise<number> {
  const { rows } = await query<{ sum: string }>(
    "SELECT COALESCE(SUM(cost_usd), 0) AS sum FROM llm_usage WHERE ts >= date_trunc('month', now())",
  );
  return Number(rows[0].sum);
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const s = fenced ? fenced[1] : text;
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  return start >= 0 && end > start ? s.slice(start, end + 1) : s;
}

export interface CompleteOptions<T> {
  prompt: string;
  schema: ZodType<T>;
  system?: string;
  model?: string;
  maxTokens?: number;
  purpose?: string;
}

export async function completeJSON<T>(opts: CompleteOptions<T>): Promise<T> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const ceiling = Number(process.env.MONTHLY_SPEND_CEILING_USD ?? 0);
  if (ceiling > 0) {
    const spent = await llmSpendThisMonth();
    if (spent >= ceiling) {
      throw new CostCeilingError(`Monthly LLM spend ceiling reached ($${spent.toFixed(2)} / $${ceiling}).`);
    }
    if (spent >= ceiling * 0.8) console.warn(`[llm] spend $${spent.toFixed(2)} of $${ceiling} ceiling (>80%)`);
  }

  const model = resolveModel(opts.model);
  const system =
    (opts.system ? `${opts.system}\n\n` : "") +
    "Respond with ONLY a single valid JSON object — no prose, no markdown code fences.";

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? 1024,
        system,
        messages: [{ role: "user", content: opts.prompt }],
      }),
    });
    if (!res.ok) {
      lastErr = new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      continue;
    }
    const body = (await res.json()) as {
      content?: Array<{ text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const usage = body.usage ?? {};
    const p = priceFor(model);
    const cost = ((usage.input_tokens ?? 0) / 1e6) * p.in + ((usage.output_tokens ?? 0) / 1e6) * p.out;
    await query(
      "INSERT INTO llm_usage (model, purpose, input_tokens, output_tokens, cost_usd) VALUES ($1,$2,$3,$4,$5)",
      [model, opts.purpose ?? null, usage.input_tokens ?? 0, usage.output_tokens ?? 0, cost],
    );

    const text = (body.content ?? []).map((c) => c.text ?? "").join("").trim();
    try {
      return opts.schema.parse(JSON.parse(extractJson(text)));
    } catch (err) {
      lastErr = new Error(`JSON parse/validate failed: ${(err as Error).message}; got: ${text.slice(0, 200)}`);
    }
  }
  throw lastErr ?? new Error("LLM completion failed");
}
