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
