import { describe, it, expect } from "vitest";
import { positioningReadout, type PositioningReadoutInput } from "./positioning_readout";
import { POSITIONING_CONFIG } from "../config/positioning";

const base = (over: Partial<PositioningReadoutInput> = {}): PositioningReadoutInput => ({
  modelRatios: { gross_margin: 0.82, net_margin: 0.28 },
  scenarioBands: { eps: { p10: 8, p50: 10, p90: 12 }, revenue_growth: { p10: 0.05, p50: 0.15, p90: 0.25 } },
  priceTarget: { bear: 120, base: 150, bull: 180 },
  spot: 100,
  lean: "constructive",
  invalidationTriggers: ["Net margin < 22% for two quarters"],
  ...over,
});

describe("positioningReadout (control P12)", () => {
  it("degrades to null when spot is missing", () => {
    expect(positioningReadout(base({ spot: null }))).toBeNull();
  });
  it("degrades to null when the scenario EPS band is missing", () => {
    expect(positioningReadout(base({ scenarioBands: { eps: null, revenue_growth: null } }))).toBeNull();
    expect(positioningReadout(base({ scenarioBands: null }))).toBeNull();
  });
  it("degrades to null when no price target is derivable", () => {
    expect(positioningReadout(base({ priceTarget: { bear: null, base: null, bull: null } }))).toBeNull();
    expect(positioningReadout(base({ priceTarget: null }))).toBeNull();
  });

  it("derives fair value from scenario EPS × the default multiple", () => {
    const r = positioningReadout(base())!;
    expect(r.fair_value.multiple).toBe(POSITIONING_CONFIG.defaultMultiple);
    expect(r.fair_value.low).toBe(8 * 15);
    expect(r.fair_value.base).toBe(10 * 15);
    expect(r.fair_value.high).toBe(12 * 15);
    expect(r.fair_value.basis).toBe(POSITIONING_CONFIG.illustrativeLabel);
  });

  it("honors an explicit consensus multiple", () => {
    const r = positioningReadout(base({ consensusMultiple: 20 }))!;
    expect(r.fair_value.multiple).toBe(20);
    expect(r.fair_value.base).toBe(10 * 20);
  });

  it("flags a lean that contradicts the spread (constructive but base <= spot)", () => {
    const r = positioningReadout(base({ spot: 200 }))!; // fvBase 150 <= spot 200
    expect(r.fair_value.consistent_with_lean).toBe(false);
    expect(r.fair_value.reconciliation).toMatch(/contradicts/);
  });
  it("is consistent when a constructive lean has base above spot", () => {
    const r = positioningReadout(base({ spot: 100 }))!; // fvBase 150 > 100
    expect(r.fair_value.consistent_with_lean).toBe(true);
  });
  it("neutral leans are always consistent", () => {
    const r = positioningReadout(base({ lean: "neutral", spot: 999 }))!;
    expect(r.fair_value.consistent_with_lean).toBe(true);
  });

  it("gives EVERY invalidation trigger an action rule, merging authored ones", () => {
    const r = positioningReadout(base({
      invalidationTriggers: ["Trigger A", "Trigger B"],
      actionRules: [{ trigger: "Trigger A", rule: "Custom rule for A" }],
    }))!;
    const byTrig = Object.fromEntries(r.action_rules.map((x) => [x.trigger, x.rule]));
    expect(byTrig["Trigger A"]).toBe("Custom rule for A");
    expect(byTrig["Trigger B"]).toBe(POSITIONING_CONFIG.defaultActionRule);
    expect(r.action_rules).toHaveLength(2);
  });
  it("keeps an authored rule whose trigger is not in the invalidation list", () => {
    const r = positioningReadout(base({
      invalidationTriggers: [],
      actionRules: [{ trigger: "Extra", rule: "Extra rule" }],
    }))!;
    expect(r.action_rules).toEqual([{ trigger: "Extra", rule: "Extra rule" }]);
  });

  it("surfaces the high-gross-margin assumption when GM clears the threshold", () => {
    const r = positioningReadout(base({ modelRatios: { gross_margin: 0.85 } }))!;
    expect(r.implied_assumptions.some((a) => /gross margin holding above/i.test(a))).toBe(true);
    expect(r.implied_assumptions.some((a) => /× P50 EPS/.test(a))).toBe(true);
  });
  it("is deterministic (no RNG)", () => {
    expect(positioningReadout(base())).toEqual(positioningReadout(base()));
  });
});
