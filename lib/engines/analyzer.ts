/**
 * The LLM-driven judgment surface for Engine 3. Defined as an interface so the engine is
 * deterministic to test (inject a fake) and the eval harness scores the real Claude analyzer.
 */
import { z } from "zod";
import { completeJSON } from "../llm/client";
import { NewsCategory, ThesisEffect, Magnitude } from "../types";

export interface AnalyzeInput {
  company: { legal_name: string; ticker: string; gics_sector: string | null; rolling_outlook: string };
  article: { title: string; snippet: string | null; source: string | null; published_at: string | null };
}

export const AnalyzeResult = z.object({
  importance_score: z.number().int().min(0).max(100),
  importance_rationale: z.string(),
  category: NewsCategory,
  impact: z.object({
    forward_outlook: z.string(),
    thesis_effect: ThesisEffect,
    sentiment_effect: z.string(),
    estimated_magnitude: Magnitude,
  }),
});
export type AnalyzeResult = z.infer<typeof AnalyzeResult>;

export interface ReadThroughInput {
  event: { company: string; headline: string; summary: string; category: string };
  neighbor: { company: string; gics_sector: string | null };
  link: { type: string; direction_note: string | null; cross_sector: boolean };
}

export const ReadThroughResult = z.object({
  material: z.boolean(),
  expected_effect: z.string(),
  materiality: Magnitude,
  thesis_effect: ThesisEffect,
});
export type ReadThroughResult = z.infer<typeof ReadThroughResult>;

export interface NewsAnalyzer {
  analyze(input: AnalyzeInput): Promise<AnalyzeResult>;
  judgeReadThrough(input: ReadThroughInput): Promise<ReadThroughResult>;
}

const RUBRIC = `Importance rubric (0-100):
- 0-39 Low: routine/no thesis impact.
- 40-69 Material: matters; updates the forward view (guidance, product, management, sector dynamics).
- 70-100 Major: moves the thesis materially (big guidance change, legal/regulatory action, M&A, governance shock).
Scoring inputs: proximity to thesis/invalidation triggers, guidance/financial impact, management/governance change,
legal/regulatory action, M&A or capital-markets action, and breadth of coverage.`;

/** Production analyzer (Claude). Model resolved by the client (Haiku under LLM_MODEL_OVERRIDE). */
export class ClaudeNewsAnalyzer implements NewsAnalyzer {
  async analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
    const { company, article } = input;
    const prompt = `You are a buy-side financial news analyst.

Company: ${company.legal_name} (${company.ticker}) — GICS sector: ${company.gics_sector ?? "unknown"}.
Current rolling outlook: ${company.rolling_outlook || "(none yet)"}

${RUBRIC}

News item:
  Headline: ${article.title}
  Source: ${article.source ?? "unknown"} | Published: ${article.published_at ?? "unknown"}
  ${article.snippet ? `Snippet: ${article.snippet}` : ""}

Score this item's importance for the company, classify its category
(guidance | product | management | legal_regulatory | macro | m_and_a | capital_markets | other),
and assess its impact. Return JSON:
{"importance_score": int 0-100, "importance_rationale": string, "category": <enum>,
 "impact": {"forward_outlook": string, "thesis_effect": "supports|pressures|neutral|invalidates",
            "sentiment_effect": string, "estimated_magnitude": "low|medium|high"}}`;
    return completeJSON({ prompt, schema: AnalyzeResult, model: "claude-sonnet-4-6", purpose: "news.analyze", maxTokens: 700 });
  }

  async judgeReadThrough(input: ReadThroughInput): Promise<ReadThroughResult> {
    const { event, neighbor, link } = input;
    const prompt = `Assess read-through across a company relationship link.

An event occurred at ${event.company}:
  Headline: ${event.headline}
  Summary: ${event.summary}
  Category: ${event.category}

It may affect ${neighbor.company} (GICS sector: ${neighbor.gics_sector ?? "unknown"}) via this link:
  Type: ${link.type} | Cross-sector: ${link.cross_sector} | How impact flows: ${link.direction_note ?? "unspecified"}

Decide whether the event has a MATERIAL read-through to ${neighbor.company}. Only flag it material if the
effect is genuinely consequential (not generic sector noise). Return JSON:
{"material": bool, "expected_effect": string, "materiality": "low|medium|high",
 "thesis_effect": "supports|pressures|neutral|invalidates"}`;
    return completeJSON({ prompt, schema: ReadThroughResult, model: "claude-sonnet-4-6", purpose: "news.readthrough", maxTokens: 500 });
  }
}
