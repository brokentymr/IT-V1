import { describe, it, expect } from "vitest";
import { catalogFacts, extractClaims, resolveEdges } from "./claim_dag";
import { CLAIM_DAG_CONFIG } from "../config/claim_dag";

const content = {
  fundamentals: {
    model: {
      period_end: "2024-06-29",
      fiscal_period: "Q3 2024",
      line_items: {
        revenue: { label: "Revenue", value: 85_777_000_000, unit: "USD", period_end: "2024-06-29" },
        net_income: { label: "Net income", value: 21_448_000_000, unit: "USD", period_end: "2024-06-29" },
      },
      ratios: { gross_margin: 0.46, net_margin: 0.25 },
    },
    provenance: [
      { claim_id: "fundamentals.revenue", source_ref: "src-rev" },
      { claim_id: "fundamentals.net_income", source_ref: "src-ni" },
    ],
  },
  hypotheses: {
    drivers: [{ name: "Services growth", metric: "revenue", framing: "Services momentum carries revenue" }],
    provenance: [{ claim_id: "hypotheses", source_ref: "src-filing" }],
  },
  scenario: {
    target_period: "Q4 2024",
    bands: { revenue: { p10: 80e9, p50: 90e9, p90: 100e9 }, eps: { p10: 1.2, p50: 1.4, p90: 1.6 } },
    watch_items: ["Watch services revenue mix next quarter"],
    provenance: [{ claim_id: "scenario", source_ref: "src-scenario" }],
  },
  levers: {
    roe: { roe: 0.5, net_margin: 0.25 },
    balance_sheet: { current_ratio: 1.1, free_cash_flow: 20e9 },
  },
  market_context: { provenance: [{ claim_id: "market_context", source_ref: "src-mc" }] },
  key_debates: ["Can services keep compounding as hardware plateaus?"],
  thesis: {
    one_liner: "Margin-led compounder driven by services revenue",
    long_form: "Long-form thesis on the durable services franchise.",
    tensions: ["Hardware cyclicality offsets services strength"],
    invalidation_triggers: ["Revenue drops below $85.8B for two quarters"],
  },
};

describe("claim_dag — pure derivation (P4)", () => {
  it("catalogFacts derives fundamentals/ratio/driver/scenario/levers/external with source refs", () => {
    const facts = catalogFacts(content);
    const byKey = new Map(facts.map((f) => [f.fact_key, f]));

    // fundamentals with per-metric provenance + period from the line item
    expect(byKey.get("fundamentals.revenue")?.source_ref).toBe("src-rev");
    expect(byKey.get("fundamentals.revenue")?.value_num).toBe(85_777_000_000);
    expect(byKey.get("fundamentals.revenue")?.period).toBe("2024-06-29");
    expect(byKey.get("fundamentals.net_income")?.source_ref).toBe("src-ni");

    // ratios fall back to the filing (first fundamentals) source ref
    expect(byKey.get("ratio.gross_margin")?.source_ref).toBe("src-rev");
    expect(byKey.get("ratio.net_margin")?.value_num).toBe(0.25);

    // driver slug + framing carried as value_text
    expect(byKey.get("driver.services-growth")?.kind).toBe("driver");
    expect(byKey.get("driver.services-growth")?.source_ref).toBe("src-filing");

    // scenario bands carry the P50 point + target period
    expect(byKey.get("scenario.revenue")?.value_num).toBe(90e9);
    expect(byKey.get("scenario.revenue")?.period).toBe("Q4 2024");
    expect(byKey.get("scenario.eps")?.value_num).toBe(1.4);

    // levers numeric leaves
    expect(byKey.get("levers.roe")?.value_num).toBe(0.5);
    expect(byKey.get("levers.free_cash_flow")?.value_num).toBe(20e9);

    // external advisory node
    expect(byKey.get("external")?.source_ref).toBe("src-mc");
    expect(byKey.get("external")?.value_num).toBeNull();
  });

  it("extractClaims makes one claim per narrative statement", () => {
    const claims = extractClaims(content);
    const kinds = claims.map((c) => c.claim_kind);
    expect(kinds).toContain("one_liner");
    expect(kinds).toContain("long_form");
    expect(kinds).toContain("tension");
    expect(kinds).toContain("invalidation_trigger");
    expect(kinds).toContain("key_debate");
    expect(kinds).toContain("watch_item");
    expect(kinds).toContain("driver_framing");
    // blank statements are dropped
    expect(claims.every((c) => c.text.length > 0)).toBe(true);
  });

  it("resolveEdges keyword-matches, and a zero-match claim falls back to ALL numeric facts", () => {
    const facts = catalogFacts(content);
    const claims = extractClaims(content);
    const edges = resolveEdges(claims, facts, CLAIM_DAG_CONFIG);

    const oneLinerIdx = claims.findIndex((c) => c.claim_kind === "one_liner");
    // "...services revenue" mentions revenue -> links the revenue-bearing facts
    expect(edges[oneLinerIdx]).toContain("fundamentals.revenue");
    expect(edges[oneLinerIdx]).toContain("scenario.revenue");

    // A claim with no metric keyword links to every numeric fact (broadFallback).
    const numericKeys = facts.filter((f) => f.value_num != null).map((f) => f.fact_key);
    const noMatch = resolveEdges([{ claim_kind: "x", ordinal: 0, text: "abc xyz" }], facts, CLAIM_DAG_CONFIG);
    expect(noMatch[0].sort()).toEqual([...numericKeys].sort());

    // broadFallback off -> zero-match claim gets no edges
    const off = resolveEdges([{ claim_kind: "x", ordinal: 0, text: "abc xyz" }], facts, { ...CLAIM_DAG_CONFIG, broadFallback: false });
    expect(off[0]).toEqual([]);
  });

  it("degrades gracefully on empty content", () => {
    expect(catalogFacts({})).toEqual([]);
    expect(extractClaims({})).toEqual([]);
    expect(resolveEdges([], [], CLAIM_DAG_CONFIG)).toEqual([]);
  });
});
