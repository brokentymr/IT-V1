import { describe, it, expect } from "vitest";
import { positioningComplete, PositioningDecision, type PositioningDecision as PD } from "../lib/engines/positioning";

const base = (over: Partial<PD> = {}): PD =>
  PositioningDecision.parse({
    strategic_stance: "constructive",
    conviction: 3,
    variant_view: "Street targets are internally incoherent; the debate is durability.",
    catalysts: [{ event: "FQ4 print", date: "2026-09-24", expected_direction: "mixed", why: "cycle read" }],
    ...over,
  });

describe("PositioningDecision schema", () => {
  it("fills defaults for an omitted price target and optional fields", () => {
    const d = base();
    expect(d.price_target).toEqual({ bear: null, base: null, bull: null });
    expect(d.is_consensus).toBe(false);
    expect(d.expected_return_pct).toBeNull();
  });
  it("rejects an out-of-range stance", () => {
    expect(() => PositioningDecision.parse({ strategic_stance: "yolo", conviction: 3, variant_view: "x" })).toThrow();
  });
});

describe("positioningComplete (publish gate)", () => {
  it("passes a real call with a variant view and catalysts", () => {
    expect(positioningComplete(base()).complete).toBe(true);
  });
  it("holds a description-only decision (no variant view)", () => {
    const r = positioningComplete(base({ variant_view: "  " }));
    expect(r.complete).toBe(false);
    expect(r.missing).toContain("variant_view");
  });
  it("holds a decision with no catalysts", () => {
    const r = positioningComplete(base({ catalysts: [] }));
    expect(r.complete).toBe(false);
    expect(r.missing).toContain("catalysts");
  });
  it("an honest consensus/pass with catalysts still publishes", () => {
    const r = positioningComplete(base({ strategic_stance: "neutral", is_consensus: true, variant_view: "no edge — pass; priced for base case" }));
    expect(r.complete).toBe(true);
  });
});
