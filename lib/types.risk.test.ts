import { describe, it, expect } from "vitest";
import { Risk, InvalidationTrigger, RiskSeverity, Thesis } from "./types";

describe("Risk / InvalidationTrigger schemas (control P10)", () => {
  it("RiskSeverity accepts the three levels and rejects others", () => {
    expect(RiskSeverity.parse("low")).toBe("low");
    expect(RiskSeverity.parse("high")).toBe("high");
    expect(() => RiskSeverity.parse("critical")).toThrow();
  });

  it("Risk defaults quantified_impact and linked_trigger_id to null", () => {
    const r = Risk.parse({ id: "r1", title: "x", mechanism: "y", severity: "medium" });
    expect(r.quantified_impact).toBeNull();
    expect(r.linked_trigger_id).toBeNull();
  });

  it("InvalidationTrigger defaults source_ref to null and keeps disclosure", () => {
    const t = InvalidationTrigger.parse({ id: "t1", condition: "c", disclosure: "d" });
    expect(t.source_ref).toBeNull();
    expect(t.disclosure).toBe("d");
  });
});

describe("Thesis schema (P10 additive, backward compatible)", () => {
  it("defaults risks[] and triggers[] to [] while keeping legacy invalidation_triggers", () => {
    const t = Thesis.parse({
      one_liner: "a", long_form: "b", conviction: 3,
      invalidation_triggers: ["margin falls below 40%"],
    });
    expect(t.risks).toEqual([]);
    expect(t.triggers).toEqual([]);
    expect(t.invalidation_triggers).toEqual(["margin falls below 40%"]);
  });

  it("parses a fully typed, joined risk/trigger thesis", () => {
    const t = Thesis.parse({
      one_liner: "a", long_form: "b", conviction: 4,
      invalidation_triggers: [],
      risks: [{ id: "r1", title: "Demand air-pocket", mechanism: "hyperscaler capex pause", severity: "high", linked_trigger_id: "t1" }],
      triggers: [{ id: "t1", condition: "DC revenue declines QoQ", disclosure: "10-Q segment revenue", source_ref: null }],
    });
    expect(t.risks[0].linked_trigger_id).toBe("t1");
    expect(t.risks[0].quantified_impact).toBeNull();
    expect(t.triggers[0].id).toBe("t1");
  });
});
