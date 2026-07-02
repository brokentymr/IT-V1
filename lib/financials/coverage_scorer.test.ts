import { describe, it, expect } from "vitest";
import {
  scoreDisclosureCoverage,
  coverageScorecardLog,
  keywordExcerpts,
  type CoverageInput,
  type ScorerModel,
} from "./coverage_scorer";

// A "fully disclosed" model: revenue + gross margin + diluted EPS + OCF + capex all present.
const fullModel = (over: Partial<Record<string, number>> = {}): ScorerModel => ({
  line_items: {
    revenue: { value: over.revenue ?? 85_000_000_000 },
    net_income: { value: over.net_income ?? 21_000_000_000 },
    eps_diluted: { value: over.eps_diluted ?? 1.4 },
    operating_cash_flow: { value: over.operating_cash_flow ?? 28_000_000_000 },
    capex: { value: over.capex ?? 3_000_000_000 },
  },
  ratios: { gross_margin: over.gross_margin ?? 0.46, net_margin: 0.25 },
});

const base = (over: Partial<CoverageInput> = {}): CoverageInput => ({
  formType: "10-Q",
  model: fullModel(),
  demand: { customer_concentration: "top 3 ≈ 45% of revenue" },
  drivers: [],
  claimTexts: [],
  filingText: null,
  ...over,
});

describe("coverage_scorer — scoreDisclosureCoverage", () => {
  it("scores full coverage as ok with no gaps when nothing conditional is disclosed", () => {
    const r = scoreDisclosureCoverage(base());
    expect(r.ok).toBe(true);
    expect(r.gaps).toHaveLength(0);
    expect(r.score).toBe(1);
    expect(r.covered).toContain("revenue");
    expect(r.covered).toContain("gm_gaap");
    expect(r.covered).toContain("fcf");
    expect(r.covered).toContain("customer_concentration");
    expect(r.form_type).toBe("10-Q");
  });

  it("holds (ok=false) when revenue — a critical line item — is missing", () => {
    const model = fullModel();
    delete model.line_items.revenue;
    const r = scoreDisclosureCoverage(base({ model }));
    expect(r.ok).toBe(false);
    const gap = r.gaps.find((g) => g.key === "revenue");
    expect(gap?.severity).toBe("critical");
  });

  it("F4 hold: an RPO/backlog figure disclosed in the filing but not captured is a critical gap", () => {
    const r = scoreDisclosureCoverage(base({
      filingText: "Total remaining performance obligations were $18.0 billion as of quarter end.",
      claimTexts: ["Margin-led compounder with resilient services."],
    }));
    expect(r.ok).toBe(false);
    const gap = r.gaps.find((g) => g.key === "rpo_backlog");
    expect(gap?.severity).toBe("critical");
    expect(gap?.disclosed_but_missing).toBe(true);
  });

  it("RPO disclosed AND captured in the analysis is covered, not a gap", () => {
    const r = scoreDisclosureCoverage(base({
      filingText: "Remaining performance obligations were $18.0 billion.",
      claimTexts: ["Backlog (remaining performance obligation) of $18B underpins forward revenue."],
    }));
    expect(r.ok).toBe(true);
    expect(r.covered).toContain("rpo_backlog");
    expect(r.gaps.find((g) => g.key === "rpo_backlog")).toBeUndefined();
  });

  it("skips all conditional items (never a false gap) when filingText is null", () => {
    const r = scoreDisclosureCoverage(base({ filingText: null }));
    // No if_disclosed key appears in gaps OR covered — they were skipped entirely.
    for (const k of ["gm_nongaap", "eps_nongaap", "guidance", "rpo_backlog", "buyback_dividend"]) {
      expect(r.checks_run).not.toContain(k);
    }
    expect(r.ok).toBe(true);
  });

  it("a disclosed RPO signal only fires when a currency figure sits nearby (avoids boilerplate)", () => {
    // 'backlog' with no dollar/scale figure nearby → not treated as disclosed → no gap.
    const r = scoreDisclosureCoverage(base({
      filingText: "We manage our order backlog carefully across product lines.",
      claimTexts: ["No RPO mention."],
    }));
    expect(r.gaps.find((g) => g.key === "rpo_backlog")).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  it("computed FCF gaps (expected, non-critical) when capex is missing", () => {
    const model = fullModel();
    delete model.line_items.capex;
    const r = scoreDisclosureCoverage(base({ model }));
    const gap = r.gaps.find((g) => g.key === "fcf");
    expect(gap?.severity).toBe("expected");
    expect(r.ok).toBe(true); // expected gaps never hold
  });

  it("customer concentration is covered via the demand profile field", () => {
    const r = scoreDisclosureCoverage(base({ demand: { customer_concentration: "one customer >10% of revenue" } }));
    expect(r.covered).toContain("customer_concentration");
  });

  it("customer concentration is covered via a text pattern match when demand is empty", () => {
    const r = scoreDisclosureCoverage(base({
      demand: null,
      claimTexts: ["A single customer accounted for 12% of net revenue this quarter."],
    }));
    expect(r.covered).toContain("customer_concentration");
  });

  it("customer concentration gaps (expected) when neither demand nor text asserts it", () => {
    const r = scoreDisclosureCoverage(base({ demand: null, claimTexts: ["Nothing about concentration."] }));
    const gap = r.gaps.find((g) => g.key === "customer_concentration");
    expect(gap?.severity).toBe("expected");
    expect(r.ok).toBe(true);
  });

  it("soft-flags an ungrounded forward %-of-revenue claim without holding", () => {
    const r = scoreDisclosureCoverage(base({ claimTexts: ["We expect services at ~40% of revenue next year."] }));
    expect(r.percentage_flags).toHaveLength(1);
    expect(r.percentage_flags[0].claim).toMatch(/40% of revenue/i);
    expect(r.ok).toBe(true); // soft — never holds
  });

  it("does not flag a %-claim grounded by an (estimate) tag", () => {
    const r = scoreDisclosureCoverage(base({ claimTexts: ["Services ~40% of revenue (estimate)."] }));
    expect(r.percentage_flags).toHaveLength(0);
  });

  it("does not flag a %-claim grounded by a filing-text match", () => {
    const r = scoreDisclosureCoverage(base({
      claimTexts: ["Services 40% of revenue."],
      filingText: "Services represented 40% of revenue.",
    }));
    expect(r.percentage_flags).toHaveLength(0);
  });

  it("does not flag a %-claim grounded by a driver quote", () => {
    const r = scoreDisclosureCoverage(base({
      claimTexts: ["Services 40% of revenue."],
      drivers: [{ framing: "Services mix", quote: "services were 40% of revenue" }],
    }));
    expect(r.percentage_flags).toHaveLength(0);
  });

  it("applies form globs: an 8-K skips 10-K/10-Q-only items", () => {
    const r = scoreDisclosureCoverage(base({ formType: "8-K" }));
    // gm_gaap / eps_gaap / ocf / capex / fcf are 10-K/10-Q only → not evaluated on an 8-K.
    for (const k of ["gm_gaap", "eps_gaap", "ocf", "capex", "fcf", "customer_concentration"]) {
      expect(r.checks_run).not.toContain(k);
    }
    // revenue applies to every form (has "*").
    expect(r.covered).toContain("revenue");
  });

  it("never throws on all-empty inputs and reports the critical revenue gap", () => {
    const r = scoreDisclosureCoverage({
      formType: null, model: { line_items: {}, ratios: {} }, demand: null, drivers: [], claimTexts: [], filingText: null,
    });
    expect(r.form_type).toBe("Filing");
    expect(r.ok).toBe(false);
    expect(r.gaps.find((g) => g.key === "revenue")?.severity).toBe("critical");
  });
});

describe("coverage_scorer — log + excerpt helpers", () => {
  it("coverageScorecardLog reflects pass/hold status", () => {
    const pass = coverageScorecardLog(scoreDisclosureCoverage(base()));
    expect(pass).toContain("PASS");
    const model = fullModel();
    delete model.line_items.revenue;
    const hold = coverageScorecardLog(scoreDisclosureCoverage(base({ model })));
    expect(hold).toContain("GAP-HOLD");
    expect(hold).toContain("critical:revenue");
  });

  it("keywordExcerpts returns a bounded excerpt around matched keywords", () => {
    const html = "<p>Our guidance for the next quarter is strong. Unrelated filler text here.</p>";
    const ex = keywordExcerpts(html, ["guidance"], 500);
    expect(ex).toContain("guidance");
    expect(ex.length).toBeLessThanOrEqual(500);
  });
});
