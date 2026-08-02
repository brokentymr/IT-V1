/**
 * Retrieval planner (pipeline upgrade — docs/UPGRADE-pipeline-rearchitecture.md §2.1).
 *
 * Before the desk reasons, decide what THIS name's thesis will stand on and go get it — instead of
 * reasoning from one filing plus the model's memory. The planner names the specific, sourceable facts
 * a tier-one analyst would pull first (market share, key customers, capex, segment/geographic mix,
 * historical baselines, competitive position), which the caller then fetches and folds into the
 * evidence. The LLM call is injectable; the merge/dedupe/cap logic is pure and tested.
 */
import { z } from "zod";
import { completeJSON } from "../llm/client";

export const PlanQuestion = z.object({
  topic: z.string(), // short label, e.g. "DRAM market share"
  question: z.string(), // the precise, sourceable question
  grounds: z.string().default(""), // the claim/debate it will ground
});
export type PlanQuestion = z.infer<typeof PlanQuestion>;

export const RetrievalPlan = z.object({ questions: z.array(PlanQuestion).default([]) });
export type RetrievalPlan = z.infer<typeof RetrievalPlan>;

export interface RetrievalPlannerInput {
  company: { legal_name: string; ticker: string | null; gics_sector: string | null };
  figures: string; // the headline reported figures the desk already has
  focus?: string[]; // standing research focus
}

const normKey = (q: PlanQuestion): string => q.topic.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Merge/dedupe by topic and cap the plan. Deterministic order (as authored), first-wins on dupes. */
export function normalizePlan(questions: PlanQuestion[], cap: number): PlanQuestion[] {
  const seen = new Set<string>();
  const out: PlanQuestion[] = [];
  for (const q of questions) {
    const key = normKey(q);
    if (!key || seen.has(key)) continue;
    if (!q.question.trim()) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= cap) break;
  }
  return out;
}

export interface RetrievalPlanner {
  plan(input: RetrievalPlannerInput): Promise<RetrievalPlan>;
}

export class ClaudeRetrievalPlanner implements RetrievalPlanner {
  constructor(private readonly model = "claude-sonnet-4-6", private readonly cap = 5) {}

  async plan(input: RetrievalPlannerInput): Promise<RetrievalPlan> {
    const focus = input.focus?.length ? `\nStanding research focus (weight these): ${input.focus.join(", ")}.` : "";
    const prompt = `You are the head of research scoping what to SOURCE before your desk forms a view on this company.
List the specific, externally-verifiable facts a tier-one analyst would pull FIRST — the ones a thesis
stands on and that a single filing will not contain: market/segment share and ranking vs named peers,
key customers/suppliers and concentration, capex/capacity plans, geographic & segment revenue mix,
multi-year historical baselines for the key metrics, pricing/ASP trends, and the current competitive
position. Be concrete and answerable with a citation. At most ${this.cap} questions; no filler.

Company: ${input.company.legal_name} (${input.company.ticker ?? "unlisted"}) — sector ${input.company.gics_sector ?? "unknown"}.${focus}
Reported figures the desk already has:
${input.figures}

Return JSON: {"questions": [{"topic": string, "question": string, "grounds": string}]}`;
    const plan = await completeJSON({ prompt, schema: RetrievalPlan, model: this.model, purpose: "research.retrieval_plan", maxTokens: 2400 });
    return { questions: normalizePlan(plan.questions, this.cap) };
  }
}
