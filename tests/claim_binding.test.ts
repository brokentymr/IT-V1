import { describe, it, expect } from "vitest";
import { salientTokens, matchFilingPassage, bindClaims } from "../lib/engines/claim_binding";
import { groundedCoverage } from "../lib/engines/grounding";

describe("salientTokens", () => {
  it("keeps content words + numbers, drops stopwords, strips $/%", () => {
    const t = salientTokens("Same-restaurant sales grew 9.7% and revenue was $438M");
    expect(t).toContain("restaurant");
    expect(t).toContain("sales");
    expect(t).toContain("9.7");
    expect(t).toContain("438");
    expect(t).not.toContain("and"); // stopword
    expect(t).not.toContain("was"); // stopword
  });
});

const FILING = `
<p>Revenue increased to $438.3 million for the thirteen weeks ended April 19, 2026.</p>
<p>Same Restaurant Sales grew 9.7%, driven by 6.8% traffic growth.</p>
<p>CAVA Restaurant-Level Profit Margin was 25.1% for the quarter.</p>
<p>The Company opened 15 net new CAVA restaurants during the period.</p>
`;

describe("matchFilingPassage", () => {
  it("binds a quantitative claim to the passage that contains it", () => {
    const m = matchFilingPassage("Same-restaurant sales grew 9.7% on 6.8% traffic", FILING, { minOverlap: 0.5, label: "10-Q ACC-1" });
    expect(m).not.toBeNull();
    expect(m!.citation).toContain("10-Q ACC-1");
    expect(m!.citation.toLowerCase()).toContain("9.7");
    expect(m!.overlap).toBeGreaterThanOrEqual(0.5);
  });

  it("returns null when the filing does not contain the claim's facts", () => {
    const m = matchFilingPassage("The CEO resigned amid an SEC subpoena over options backdating", FILING, { minOverlap: 0.5, label: "10-Q ACC-1" });
    expect(m).toBeNull();
  });

  it("ignores HTML tags when matching", () => {
    const m = matchFilingPassage("restaurant-level profit margin 25.1%", FILING, { minOverlap: 0.5, label: "10-Q ACC-1" });
    expect(m).not.toBeNull();
    expect(m!.passage).not.toContain("<p>");
  });

  // Precision: a figure must not match embedded inside a larger number (the "64" in "3,648" bug).
  it("does not bind a $64M claim to a passage whose only '64' is inside 3,648", () => {
    const filing = "<p>Prepaid expenses and other (2,178) (3,648) Operating lease assets (28,414).</p>";
    const m = matchFilingPassage("Operating cash flow was $64 million", filing, { minOverlap: 0.5, label: "10-Q ACC-1" });
    expect(m).toBeNull();
  });

  it("binds a rounded claim to the exact filing figure (438 → 438,270)", () => {
    const filing = "<p>CAVA Revenue increased to $438,270 for the quarter, up 32.1%.</p>";
    const m = matchFilingPassage("Revenue increased 32% to $438 million", filing, { minOverlap: 0.5, label: "10-Q ACC-1" });
    expect(m).not.toBeNull();
    expect(m!.citation).toContain("438,270");
  });

  it("does not let a shared year alone (2026) manufacture a match", () => {
    const filing = "<p>During the thirteen weeks ended April 19, 2026, the Company adopted new accounting standards not expected to have a material impact.</p>";
    const m = matchFilingPassage("Revenue grew 32% to $438 million in fiscal 2026", filing, { minOverlap: 0.5, label: "10-Q ACC-1" });
    expect(m).toBeNull(); // 2026 is excluded; 32/438 absent → no false bind to boilerplate
  });
});

describe("bindClaims", () => {
  const deps = (over = {}) => ({ filing: { text: FILING, label: "10-Q ACC-1" }, externalAsk: null, perClaimExternalQueries: 0, minOverlap: 0.5, ...over });

  it("binds filing-citable claims and flags the rest unverifiable when no external source", async () => {
    const res = await bindClaims(
      ["Same restaurant sales grew 9.7%", "The company faces a $2.2B insider-trading allegation"],
      deps(),
    );
    const byClaim = Object.fromEntries(res.map((r) => [r.claim, r]));
    expect(byClaim["Same restaurant sales grew 9.7%"].status).toBe("supported");
    expect(byClaim["Same restaurant sales grew 9.7%"].citation).toContain("10-Q ACC-1");
    expect(byClaim["The company faces a $2.2B insider-trading allegation"].status).toBe("unverifiable");
  });

  it("falls back to an external source WITH a url when the filing can't cover the claim", async () => {
    const externalAsk = async () => ({ text: "Analysts flagged a $2.2B options case on 2026-07-30.", url: "https://news.example/cava-case" });
    const res = await bindClaims(["A $2.2B insider-trading allegation against the board"], deps({ externalAsk, perClaimExternalQueries: 1 }));
    expect(res[0].status).toBe("supported");
    expect(res[0].citation).toContain("https://news.example/cava-case");
  });

  it("treats an external answer with NO url as uncitable → unverifiable", async () => {
    const externalAsk = async () => ({ text: "Some vague unsourced claim.", url: null });
    const res = await bindClaims(["A privately-held competitive datapoint"], deps({ externalAsk, perClaimExternalQueries: 1 }));
    expect(res[0].status).toBe("unverifiable");
  });
});

describe("groundedCoverage excludes unverifiable from the denominator", () => {
  it("a name well-grounded on filings clears once genuine gaps are dropped", () => {
    const verification = {
      recommendation: "auto" as const,
      confidence: 0.7,
      verdicts: [
        { status: "supported" as const, citation: "10-Q: rev $438M" },
        { status: "supported" as const, citation: "10-Q: SSS 9.7%" },
        { status: "supported" as const, citation: "10-Q: margin 25.1%" },
        { status: "unverified" as const, citation: "", unverifiable: true }, // private datapoint, dropped
      ],
    };
    const rep = groundedCoverage(verification, { requireCitation: true });
    expect(rep.total).toBe(3);          // the unverifiable claim left the denominator
    expect(rep.supported).toBe(3);
    expect(rep.unverifiable).toBe(1);
    expect(rep.coverage).toBe(1);       // 3/3, not 3/4 = 0.75
  });
});
