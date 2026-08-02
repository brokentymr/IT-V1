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

/**
 * Best-effort repair of a JSON object truncated mid-stream (the model hit max_tokens partway through an
 * array/object). Cuts back to the last structural close that is OUTSIDE a string, drops a dangling
 * separator, and appends the closers for any still-open containers — so a truncated array-of-objects
 * yields the elements that DID complete rather than a total parse failure. Returns null when nothing is
 * salvageable. Used only on the failure path (after a normal parse throws), so it never alters the
 * happy path; a bad repair just re-throws the same way the un-repaired parse would.
 */
export function repairJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  if (start < 0) return null;
  const s = raw.slice(start);
  // First pass: find the last '}' or ']' that closes a container outside of a string.
  let inStr = false, esc = false, lastBoundary = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "}" || ch === "]") lastBoundary = i;
  }
  if (lastBoundary < 0) return null;
  let cut = s.slice(0, lastBoundary + 1);
  // Second pass: recompute the still-open container stack over the cut, then close it.
  const stack: string[] = [];
  inStr = false; esc = false;
  for (let i = 0; i < cut.length; i++) {
    const ch = cut[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  cut = cut.replace(/[\s,]+$/, "");
  while (stack.length) cut += stack.pop();
  return cut;
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
  let lastText = "";
  // Budget can grow across attempts: a response that stopped on `max_tokens` was truncated, so retrying
  // with the SAME budget fails identically — double it (capped) before the next try. This is the root-cause
  // fix for the retrieval-planner (and any long-output engine) failing on truncated JSON.
  let budget = opts.maxTokens ?? 1024;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: budget,
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
      stop_reason?: string;
    };
    const usage = body.usage ?? {};
    const p = priceFor(model);
    const cost = ((usage.input_tokens ?? 0) / 1e6) * p.in + ((usage.output_tokens ?? 0) / 1e6) * p.out;
    await query(
      "INSERT INTO llm_usage (model, purpose, input_tokens, output_tokens, cost_usd) VALUES ($1,$2,$3,$4,$5)",
      [model, opts.purpose ?? null, usage.input_tokens ?? 0, usage.output_tokens ?? 0, cost],
    );

    const text = (body.content ?? []).map((c) => c.text ?? "").join("").trim();
    lastText = text;
    try {
      return opts.schema.parse(JSON.parse(extractJson(text)));
    } catch (err) {
      lastErr = new Error(`JSON parse/validate failed: ${(err as Error).message}; got: ${text.slice(0, 200)}`);
      // Truncated? Give the next attempt more room instead of re-sending the same doomed request.
      if (body.stop_reason === "max_tokens") budget = Math.min(budget * 2, 8192);
    }
  }
  // Last resort: salvage a truncated-but-mostly-complete object rather than fail the whole stage.
  const repaired = repairJson(lastText);
  if (repaired) {
    try {
      const value = opts.schema.parse(JSON.parse(repaired));
      console.warn(`[llm] ${opts.purpose ?? "completion"} recovered via JSON repair (response was truncated)`);
      return value;
    } catch { /* fall through to throw the original error */ }
  }
  throw lastErr ?? new Error("LLM completion failed");
}
