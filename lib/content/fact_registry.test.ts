import { describe, it, expect } from "vitest";
import { buildFactRegistry, renderRegistryBlock, markUsed } from "./fact_registry";
import type { Substance } from "./assemble";

function substance(overrides: Partial<Substance> = {}): Substance {
  return {
    company: { id: "c1", legal_name: "AAA Corp", ticker: "AAA", sector: "Information Technology", listing: "listed", positions_held: [] },
    snapshot_id: "s1", as_of: "2026-03-28", cycle_label: "10-Q Q2 2026", approved_at: "2026-03-29T00:00:00",
    thesis: { one_liner: "Margin-led compounder", long_form: "Long.", tensions: [], invalidation_triggers: [], conviction: 4, risks: [], triggers: [] },
    numbers: [
      { label: "Revenue", value: 85e9, unit: "USD", yoy_pct: 0.05, basis: "gaap" },
      { label: "EPS", value: 1.5, unit: "USD/shares", yoy_pct: null, basis: "gaap" },
    ],
    scenario: { target_period: "2026-09-30", revenue: { p10: 74e9, p50: 108e9, p90: 120e9 }, eps: { p10: 1.2, p50: 1.5, p90: 1.9 }, beat_rev: 0.53, watch_items: ["Products revenue"] },
    drivers: [],
    sentiment: { gap_direction: "sentiment_ahead", gap_magnitude: "high", gap_rationale: "Crowd euphoric.", ground_momentum: "Retail bullish.", by_platform: [] },
    signals: [{ ts: "2026-03-27T00:00:00", kind: "close", price: 190.25 }],
    rolling_outlook: "Watch services growth", open_areas: [], provenance: [{ ref: "src-1", origin: "SEC EDGAR", url: null, title: "10-Q" }],
    ...overrides,
  };
}

describe("fact_registry.buildFactRegistry", () => {
  it("materializes fundamentals with the deck/podcast formatters and the yoy suffix", () => {
    const reg = buildFactRegistry(substance());
    const rev = reg.byKey.get("fundamentals.Revenue")!;
    expect(rev.canonical_statement).toBe("Revenue of $85.0B (YoY 5.0%)");
    expect(rev.value_tokens).toContain("$85.0B");
    expect(rev.source_ref).toBe("src-1");
    const eps = reg.byKey.get("fundamentals.EPS")!;
    expect(eps.canonical_statement).toBe("EPS of 1.50"); // USD/shares uses toFixed(2), no yoy
  });

  it("materializes scenario bands, P(beat), sentiment gap, and price signals", () => {
    const reg = buildFactRegistry(substance());
    expect(reg.byKey.get("scenario.revenue")!.canonical_statement).toContain("$74.0B (P10)");
    expect(reg.byKey.get("scenario.beat_rev")!.canonical_statement).toContain("0.53");
    expect(reg.byKey.get("sentiment.gap")!.canonical_statement).toContain("sentiment_ahead");
    expect(reg.byKey.get("signal.0")!.canonical_statement).toContain("190.25");
  });

  it("degrades gracefully when scenario and sentiment are null", () => {
    const reg = buildFactRegistry(substance({ scenario: null, sentiment: null, signals: [] }));
    expect(reg.facts.every((f) => f.key.startsWith("fundamentals."))).toBe(true);
    expect(reg.facts.length).toBe(2);
  });

  it("caps fundamentals at maxFundamentals", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ label: `M${i}`, value: (i + 1) * 1e9, unit: "USD", yoy_pct: null, basis: "gaap" }));
    const reg = buildFactRegistry(substance({ numbers: many }));
    expect(reg.facts.filter((f) => f.key.startsWith("fundamentals.")).length).toBe(6);
  });
});

describe("fact_registry.markUsed / renderRegistryBlock", () => {
  it("tracks first use", () => {
    const reg = buildFactRegistry(substance());
    expect(markUsed(reg, "fundamentals.Revenue")).toBe(true);  // first use
    expect(markUsed(reg, "fundamentals.Revenue")).toBe(false); // subsequent
    expect(markUsed(reg, "does.not.exist")).toBe(false);
  });

  it("renders a prompt block naming the canonical facts and the first-use rule", () => {
    const block = renderRegistryBlock(buildFactRegistry(substance()));
    expect(block).toContain("Revenue of $85.0B");
    expect(block).toContain("cite its source");
    expect(block.toLowerCase()).toContain("first time");
  });

  it("renders an empty block when there are no facts", () => {
    const reg = buildFactRegistry(substance({ numbers: [], scenario: null, sentiment: null, signals: [] }));
    expect(renderRegistryBlock(reg)).toBe("");
  });
});
