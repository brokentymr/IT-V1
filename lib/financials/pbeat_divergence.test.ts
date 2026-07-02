import { describe, it, expect } from "vitest";
import { trailingBeatRate, pbeatDivergenceNote } from "./pbeat_divergence";
import type { FinancialModel } from "./model";
import type { CompanyFacts, XbrlUnitValue } from "../sources/sec";
import { PBEAT_CONFIG } from "../config/fundamentals";
import type { ScenarioOutput } from "./montecarlo";

const REV_TAG = "RevenueFromContractWithCustomerExcludingAssessedTax";

// A quarter's XBRL flow value (~91-day duration so isQuarter accepts it).
const q = (start: string, end: string, fp: string, val: number): XbrlUnitValue =>
  ({ start, end, fp, val, fy: Number(end.slice(0, 4)), form: "10-Q", accn: `acc-${end}` });

/** Build company facts from a revenue series keyed by [end,fp,val]. */
function factsFrom(rows: XbrlUnitValue[]): CompanyFacts {
  return { cik: "1", entity_name: "TEST", facts: { "us-gaap": { [REV_TAG]: { units: { USD: rows } } } } };
}

// 8 quarters: 2023 flat at 100, 2024 = +20% / -10% / +30% / +40% → 3 of 4 YoY growths positive (0.75).
const EIGHT_Q = factsFrom([
  q("2023-01-01", "2023-04-01", "Q1", 100), q("2023-04-01", "2023-07-01", "Q2", 100),
  q("2023-07-01", "2023-09-30", "Q3", 100), q("2023-10-01", "2023-12-31", "Q4", 100),
  q("2024-01-01", "2024-04-01", "Q1", 120), q("2024-04-01", "2024-07-01", "Q2", 90),
  q("2024-07-01", "2024-09-30", "Q3", 130), q("2024-10-01", "2024-12-31", "Q4", 140),
]);

// Only two YoY-able quarters → below minHistoryPeriods.
const TWO_Q = factsFrom([
  q("2023-01-01", "2023-04-01", "Q1", 100), q("2023-04-01", "2023-07-01", "Q2", 100),
  q("2024-01-01", "2024-04-01", "Q1", 120), q("2024-04-01", "2024-07-01", "Q2", 90),
]);

const model: FinancialModel = {
  period_end: "2024-09-30", fiscal_period: "Q3 2024",
  line_items: { revenue: { value: 130, label: "Revenue", unit: "USD", yoy: { change_pct: 0.30, prior_value: 100, prior_end: "2023-09-30" } } },
  ratios: {},
} as unknown as FinancialModel;

const sensitivity: ScenarioOutput["sensitivity"] = [{ driver: "AI datacenter demand", metric: "revenue", contribution: 0.5 }];
const bp = (revenue: number | null): ScenarioOutput["beat_probability"] => ({ revenue, eps: null });

describe("control P7 — P(beat) divergence (pure)", () => {
  describe("trailingBeatRate", () => {
    it("is the fraction of trailing quarterly YoY revenue growths that are positive", () => {
      expect(trailingBeatRate(EIGHT_Q, PBEAT_CONFIG)).toBeCloseTo(0.75, 5);
    });
    it("is null below minHistoryPeriods (never fabricated from too few quarters)", () => {
      expect(trailingBeatRate(TWO_Q, PBEAT_CONFIG)).toBeNull();
      expect(trailingBeatRate(factsFrom([]), PBEAT_CONFIG)).toBeNull();
    });
  });

  describe("pbeatDivergenceNote", () => {
    it("emits ONE momentum-proxy sentence when model P(beat) diverges beyond the threshold", () => {
      const note = pbeatDivergenceNote(bp(0.2), 0.75, model, sensitivity, PBEAT_CONFIG);
      expect(note).not.toBeNull();
      expect(note).toContain("Momentum proxy (NOT a forecast)");
      expect(note).toContain("20% chance of beating");
      expect(note).toContain("55pts below");
      expect(note).toContain("75% of trailing");
      expect(note).toContain("latest reported revenue YoY 30.0%");
      expect(note).toContain("AI datacenter demand");
    });

    it("labels the model as 'richer than' when it implies more beats than history", () => {
      const note = pbeatDivergenceNote(bp(0.95), 0.25, model, sensitivity, PBEAT_CONFIG);
      expect(note).toContain("95% chance of beating");
      expect(note).toContain("70pts richer than");
    });

    it("returns null within threshold (no note when the two rates broadly agree)", () => {
      expect(pbeatDivergenceNote(bp(0.5), 0.75, model, sensitivity, PBEAT_CONFIG)).toBeNull(); // |50-75|=25 <= 30
    });

    it("returns null when either rate is unavailable (never fabricates)", () => {
      expect(pbeatDivergenceNote(bp(null), 0.75, model, sensitivity, PBEAT_CONFIG)).toBeNull();
      expect(pbeatDivergenceNote(bp(0.2), null, model, sensitivity, PBEAT_CONFIG)).toBeNull();
    });

    it("degrades gracefully when there is no reported YoY or ranked driver", () => {
      const bare = { ...model, line_items: { revenue: { value: 130, label: "Revenue", unit: "USD", yoy: null } } } as unknown as FinancialModel;
      const note = pbeatDivergenceNote(bp(0.9), 0.2, bare, [], PBEAT_CONFIG);
      expect(note).toContain("no reported YoY on file");
      expect(note).toContain("an unranked driver");
    });
  });
});
