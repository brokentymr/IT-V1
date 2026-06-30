/**
 * Price-move attribution (Phase 6). When an abnormal move opens a price_action area of interest, the
 * attributor answers "why did it move?" across angles — technical (the move + recent range/vol),
 * macro (the move relative to the market: idiosyncratic vs market-wide), news (coincident open areas),
 * and fundamental (the standing thesis) — then returns a verdict in the shared AOI vocabulary so a
 * move can be put to bed by technicals/macro WITHOUT waiting for the next filing.
 *
 * Injectable so the engine is deterministic in tests. Sonnet (cheap judgment over assembled evidence).
 */
import { z } from "zod";
import { completeJSON } from "../llm/client";
import { RESOLUTION_VERDICTS } from "./areas_of_interest";

export interface PriceAttributionInput {
  company: { legal_name: string; ticker: string };
  move: { date: string; stock_pct: number; benchmark_pct: number | null; idiosyncratic_pct: number | null; sigma: number | null };
  technical: string;
  coincident_areas: string[];
  thesis: { one_liner: string | null; conviction: number | null; invalidation_triggers: string[] } | null;
}

export const PriceAttribution = z.object({
  explanation: z.string(),
  primary_driver: z.enum(["technical", "fundamental", "macro", "news", "unknown"]),
  verdict: z.enum(RESOLUTION_VERDICTS),
  note: z.string(),
});
export type PriceAttribution = z.infer<typeof PriceAttribution>;

export interface PriceAttributor {
  attribute(input: PriceAttributionInput): Promise<PriceAttribution>;
}

const pct = (n: number | null) => (n == null ? "n/a" : `${(n * 100).toFixed(1)}%`);

export class ClaudePriceAttributor implements PriceAttributor {
  async attribute(input: PriceAttributionInput): Promise<PriceAttribution> {
    const { company, move } = input;
    const prompt = `You are a markets analyst attributing a single-day price move. Decide WHY it moved across
four angles and return a verdict.

Company: ${company.legal_name} (${company.ticker})
Move on ${move.date}: stock ${pct(move.stock_pct)} | market benchmark ${pct(move.benchmark_pct)} | idiosyncratic (stock − market) ${pct(move.idiosyncratic_pct)} | size ${move.sigma == null ? "n/a" : `${move.sigma.toFixed(1)}σ`}
Technical: ${input.technical}
Coincident open areas of interest (news/events): ${input.coincident_areas.length ? input.coincident_areas.join("; ") : "(none)"}
Standing thesis: ${input.thesis?.one_liner ?? "(none)"}${input.thesis?.conviction ? ` (conviction ${input.thesis.conviction}/5)` : ""}
Invalidation triggers: ${input.thesis?.invalidation_triggers?.length ? input.thesis.invalidation_triggers.join("; ") : "(none)"}

Reason across TECHNICAL (the move itself), MACRO (is it market-wide — small idiosyncratic component — or stock-specific?),
NEWS (does a coincident area explain it?), and FUNDAMENTAL (does it bear on the thesis / hit an invalidation trigger?).
Then give a verdict:
- "overreaction": the move is mostly market-wide OR not justified by any news/fundamental — the street overreacted, no lasting thesis impact. Resolve.
- "confirmed": a real, stock-specific development (often a coincident news area) drove it and it bears on the thesis. Resolve.
- "invalidated": the move rules out a feared (or hoped) scenario the thesis hinged on. Resolve.
- "carry_forward": stock-specific and material but not yet conclusive — revisit at the next filing.
- "leave_open": cannot attribute it from what's here.

Return JSON: {"explanation": string (one sentence, cite the angle), "primary_driver": "technical|fundamental|macro|news|unknown", "verdict": "invalidated|confirmed|overreaction|carry_forward|leave_open", "note": string}`;
    return completeJSON({ prompt, schema: PriceAttribution, model: "claude-sonnet-4-6", purpose: "price.attribute", maxTokens: 700 });
  }
}
