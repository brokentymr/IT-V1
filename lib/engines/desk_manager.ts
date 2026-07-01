/**
 * The Desk Manager (Workstream C+) — the LLM "middle management" that RUNS the analyst desk and pushes
 * each thesis to confident completion. Instead of a fixed enrich→relens→bump ladder, the manager reads
 * the current state each round (thesis, the adversarial fact-checker's verdicts, what's already been
 * tried, budget left) and decides the single best next move: gather specific evidence, re-run the desk
 * on a sharpened focus (optionally at a higher model tier), or conclude (confident / hold). It never
 * concludes "confident" while a contradicted claim stands — that safety is also enforced in code.
 */
import { z } from "zod";
import { completeJSON } from "../llm/client";

export const ManagerDecision = z.object({
  action: z.enum(["enrich", "reanalyze", "conclude"]),
  verdict: z.enum(["confident", "hold"]).nullable().default(null), // only when action === "conclude"
  escalate: z.boolean().default(false),                            // reanalyze at the top model tier
  focus: z.array(z.string()).default([]),                          // precise topics / questions to chase
  target_claims: z.array(z.string()).default([]),
  rationale: z.string(),
});
export type ManagerDecision = z.infer<typeof ManagerDecision>;

export interface ManagerState {
  company: { legal_name: string; ticker: string | null };
  round: number;
  maxRounds: number;
  confidence: number;
  bar: number;
  thesis: { one_liner: string; long_form: string; conviction: number };
  verdicts: Array<{ claim: string; status: string }>;
  missing_sources: string[];
  history: Array<{ round: number; action: string; focus: string[]; confidence_after: number }>;
  budget_note: string;
}

export interface DeskManager {
  decide(state: ManagerState): Promise<ManagerDecision>;
}

export class ClaudeDeskManager implements DeskManager {
  constructor(private readonly model = "claude-opus-4-8") {}

  async decide(state: ManagerState): Promise<ManagerDecision> {
    const contradicted = state.verdicts.filter((v) => v.status === "contradicted");
    const unverified = state.verdicts.filter((v) => v.status === "unverified");
    const hist = state.history.map((h) => `R${h.round} ${h.action}(${h.focus.join(", ") || "—"})→${(h.confidence_after * 100).toFixed(0)}%`).join(" | ") || "(none yet)";

    const prompt = `You are the HEAD OF RESEARCH running an equity desk and driving this thesis to CONFIDENT completion.
You manage: four analyst lenses (equity, sector, technology, risk), a senior synthesizer, an adversarial
fact-checker, and a source-gathering researcher (SEC filings + market data). Each round you pick the SINGLE
best next move to raise GENUINE confidence and close the open gaps — or you conclude.

Company: ${state.company.legal_name} (${state.company.ticker ?? "unlisted"})
Round ${state.round} of ${state.maxRounds}. ${state.budget_note}
Desk confidence: ${(state.confidence * 100).toFixed(0)}% (publish bar ${(state.bar * 100).toFixed(0)}%).
Thesis: ${state.thesis.one_liner}
${state.thesis.long_form}
Conviction ${state.thesis.conviction}/5.
CONTRADICTED claims (${contradicted.length}): ${contradicted.map((v) => v.claim).join("; ") || "none"}
UNVERIFIED claims (${unverified.length}): ${unverified.map((v) => v.claim).join("; ") || "none"}
Missing sources the checker wants: ${state.missing_sources.join("; ") || "none"}
What you've already tried: ${hist}

Choose ONE action:
- "enrich": commission the researcher to gather SPECIFIC external facts that would resolve the unverified
  claims or fill the missing sources. Put the precise questions/topics in "focus".
- "reanalyze": re-run the lenses + synthesis with a sharpened "focus" (set "escalate": true to use the top
  model tier). Use when the ANALYSIS itself must go deeper, reconcile a tension, or address a contradiction.
- "conclude": stop with a verdict. This is EDUCATIONAL research, not a certainty guarantee — the bar is
  "honest and well-supported," not "provably certain." Conclude "verdict":"confident" when the load-bearing
  claims are SUPPORTED by the evidence and NO claim is contradicted — even if the fact-checker's overall
  confidence is only moderate (~0.55-0.70); genuine equity analysis rarely exceeds that. Conclude
  "verdict":"hold" ONLY if key claims remain unverified/contradicted, the thesis is internally broken, or
  more evidence would plausibly flip the view. A thesis with a clear majority of supported claims and zero
  contradictions is PUBLISHABLE.

Rules: never conclude "confident" while any contradicted claim stands. Don't repeat a move that history shows
didn't move the needle — change the focus or the action (enrich twice at the same confidence means the
bottleneck is analytical, not informational → reanalyze). Be decisive; you have limited rounds, so spend
early rounds closing gaps and CONCLUDE once the claims are supported rather than chasing a perfect number.

Return JSON: {"action":"enrich|reanalyze|conclude","verdict":"confident"|"hold"|null,"escalate":boolean,"focus":[string],"target_claims":[string],"rationale":string}`;

    return completeJSON({ prompt, schema: ManagerDecision, model: this.model, purpose: "desk.manager", maxTokens: 1200 });
  }
}
