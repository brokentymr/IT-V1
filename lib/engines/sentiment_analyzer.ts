/**
 * The LLM judgment surface for Engine 4. Deterministic aggregates (volume, net sentiment, trend) are
 * computed in TS; the analyzer narrates the ground-momentum, extracts per-platform themes, and reasons
 * the sentiment-vs-fundamentals gap. Interface so the engine is deterministic to test (inject a fake).
 */
import { z } from "zod";
import { completeJSON } from "../llm/client";

export interface SentimentAnalyzeInput {
  company: { legal_name: string; ticker: string };
  platforms: Array<{ platform: string; volume: number; sentiment: number; trend: string; samples: string[] }>;
  fundamentals: { thesis: string | null; conviction: number | null; recent_direction: string };
  /** Control P7: every contributing platform is below the volume floor — forbid tempo/velocity claims. */
  suppress_tempo?: boolean;
  /** The velocity phrases (from config) the narrative must avoid when suppress_tempo is set. */
  bannedPhrases?: string[];
}

export const Gap = z.object({
  direction: z.enum(["sentiment_ahead", "sentiment_behind", "aligned"]),
  magnitude: z.enum(["low", "medium", "high"]),
  rationale: z.string(),
});
export type Gap = z.infer<typeof Gap>;

export const SentimentSynthesis = z.object({
  by_platform_themes: z.array(z.object({ platform: z.string(), top_themes: z.array(z.string()).default([]) })).default([]),
  ground_momentum: z.string(),
  gap: Gap,
});
export type SentimentSynthesis = z.infer<typeof SentimentSynthesis>;

export interface SentimentAnalyzer {
  synthesize(input: SentimentAnalyzeInput): Promise<SentimentSynthesis>;
}

const fmtSent = (n: number) => (n > 0.15 ? `bullish (${n.toFixed(2)})` : n < -0.15 ? `bearish (${n.toFixed(2)})` : `mixed (${n.toFixed(2)})`);

export class ClaudeSentimentAnalyzer implements SentimentAnalyzer {
  async synthesize(input: SentimentAnalyzeInput): Promise<SentimentSynthesis> {
    const { company } = input;
    const platforms = input.platforms.map((p) =>
      `### ${p.platform} — volume ${p.volume}, ${fmtSent(p.sentiment)}, trend ${p.trend}\n${p.samples.slice(0, 8).map((s) => `- ${s}`).join("\n") || "(no text samples)"}`,
    ).join("\n\n");

    const tempoGuard = input.suppress_tempo
      ? `\n\nSTATISTICAL FLOOR (control P7): every platform is below the volume floor — the sample is too thin to claim any tempo. Describe the crowd in STATIC terms only. Do NOT claim momentum, acceleration, or velocity, and do NOT use words like: ${(input.bannedPhrases ?? []).join(", ")}. State that volume is insufficient to read a trend.`
      : "";

    const prompt = `You are a market-sentiment analyst. Read the crowd across platforms, then compare it to the fundamentals.${tempoGuard}

Company: ${company.legal_name} (${company.ticker})
Standing thesis: ${input.fundamentals.thesis ?? "(none)"}${input.fundamentals.conviction ? ` (conviction ${input.fundamentals.conviction}/5)` : ""}
Recent fundamental direction: ${input.fundamentals.recent_direction}

Platform signals:
${platforms}

Do three things:
1. For each platform, name at most 3 concrete top_themes the crowd is talking about (not generic).
2. Write a 2-3 sentence GROUND-MOMENTUM narrative: what is actually driving the crowd right now, and is it building or fading.
3. Assess the SENTIMENT-VS-FUNDAMENTALS GAP — does the crowd lead or lag what the fundamentals justify?
   - "sentiment_ahead": crowd is more bullish than the fundamentals support (euphoria / crowding risk).
   - "sentiment_behind": crowd is more bearish than the fundamentals support (fear / possible mispricing).
   - "aligned": the crowd and the fundamentals broadly agree.
   Give a magnitude (low/medium/high) and a one-sentence rationale tying the crowd read to the thesis.

Return JSON:
{"by_platform_themes": [{"platform": string, "top_themes": [string]}],
 "ground_momentum": string,
 "gap": {"direction": "sentiment_ahead|sentiment_behind|aligned", "magnitude": "low|medium|high", "rationale": string}}`;
    return completeJSON({ prompt, schema: SentimentSynthesis, model: "claude-sonnet-4-6", purpose: "sentiment.synthesize", maxTokens: 1200 });
  }
}
