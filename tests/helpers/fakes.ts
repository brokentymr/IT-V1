import type { ResearchPanel, ResearchResult, AreaAdjudication } from "../../lib/engines/research";
import type { ResolutionVerdict } from "../../lib/engines/areas_of_interest";
import type { NewsAnalyzer, AnalyzeResult, ReadThroughResult } from "../../lib/engines/analyzer";
import type { NewsArticle, NewsSource } from "../../lib/sources/news";
import type { SourceResult } from "../../lib/sources/types";
import type { JobName, Queue } from "../../lib/queue/types";

export class FakeQueue implements Queue {
  jobs: Array<{ name: JobName; data: unknown }> = [];
  async enqueue(name: JobName, data: Record<string, unknown>) {
    this.jobs.push({ name, data });
    return `job-${this.jobs.length}`;
  }
}

/** A news source returning canned articles keyed by ticker. */
export function fakeNews(byTicker: Record<string, NewsArticle[]>): NewsSource {
  return {
    async fetchCompanyNews({ tickers }) {
      return {
        ok: true,
        data: byTicker[tickers[0]] ?? [],
        missing: [],
        provenance: { origin: "fake", url: "x", retrieved_at: new Date().toISOString() },
      } as SourceResult<NewsArticle[]>;
    },
  };
}

/** A deterministic research panel: fixed thesis + verification (no live LLM). */
export function fakeResearchPanel(
  opts: { confidence?: number; recommendation?: "auto" | "review"; areaVerdict?: (theme: string) => ResolutionVerdict } = {},
): ResearchPanel {
  return {
    async adjudicateAreas({ areas }): Promise<AreaAdjudication> {
      return { resolutions: areas.map((a) => ({ theme: a.theme, verdict: opts.areaVerdict?.(a.theme) ?? "leave_open", note: `verdict for ${a.theme}` })) };
    },
    async runResearch(): Promise<ResearchResult> {
      return {
        panel: [
          { lens: "equity", summary: "Strong fundamentals.", key_points: ["margin"], claims: [{ statement: "revenue grew", basis: "XBRL", grounded: true, confidence: 0.9 }], risks: ["valuation"], confidence: 0.8 },
          { lens: "sector", summary: "Leader.", key_points: ["share"], claims: [], risks: ["competition"], confidence: 0.75 },
          { lens: "technology", summary: "Wide moat.", key_points: ["ecosystem"], claims: [], risks: ["disruption"], confidence: 0.8 },
          { lens: "risk", summary: "Bear case: demand.", key_points: [], claims: [], risks: ["demand destruction"], confidence: 0.6 },
        ],
        thesis: {
          one_liner: "Margin-led compounder", long_form: "Long.", actual_vs_expected: "Beat on revenue.",
          tensions: ["China demand"], key_debates: [{ question: "Is margin durable?", bull: "mix shift", bear: "cyclical", lean: "durable ~2 quarters" }],
          invalidation_triggers: ["Net margin < 22% for two quarters"], risks: [], triggers: [], conviction: 4, claims_to_verify: ["revenue grew"],
        },
        verification: {
          verdicts: [{ claim: "revenue grew", status: "supported", note: "XBRL confirms", citation: "XBRL: revenue YoY" }],
          confidence: opts.confidence ?? 0.82, missing_sources: ["earnings call transcript"], recommendation: opts.recommendation ?? "auto",
        },
      };
    },
  };
}

/** A deterministic analyzer: importance from a title scorer; read-through from a per-neighbor verdict. */
export function fakeAnalyzer(opts: {
  score: (title: string) => number;
  category?: AnalyzeResult["category"];
  readThrough?: (neighbor: string) => { material: boolean; materiality: "low" | "medium" | "high" };
}): NewsAnalyzer {
  return {
    async analyze({ article }): Promise<AnalyzeResult> {
      const s = opts.score(article.title);
      return {
        importance_score: s,
        importance_rationale: "fake",
        category: opts.category ?? "other",
        impact: {
          forward_outlook: `outlook for ${article.title}`,
          thesis_effect: s >= 70 ? "pressures" : "neutral",
          sentiment_effect: "neutral",
          estimated_magnitude: s >= 70 ? "high" : s >= 40 ? "medium" : "low",
        },
      };
    },
    async judgeReadThrough({ neighbor }): Promise<ReadThroughResult> {
      const v = opts.readThrough?.(neighbor.company) ?? { material: false, materiality: "low" as const };
      return {
        material: v.material,
        expected_effect: `effect on ${neighbor.company}`,
        materiality: v.materiality,
        thesis_effect: "pressures",
      };
    },
  };
}
