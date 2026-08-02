// Verify the coverage-closer on CAVA's REAL 10-Q: take a set of load-bearing claims (some citable from
// the filing, some genuinely external), run the agentic per-claim binder against the real filing text +
// live Perplexity, and show coverage lift + the honest unverifiable ceiling.
//   npx tsx scripts/verify-coverage-closer.ts
import { loadEnv } from "../lib/env";
loadEnv();
import { bindClaims } from "../lib/engines/claim_binding";
import { groundedCoverage } from "../lib/engines/grounding";
import { PerplexityClient } from "../lib/sources/perplexity";
import { DESK_CONFIG } from "../lib/config/desk";

const FILING_URL = "https://www.sec.gov/Archives/edgar/data/1639438/000162828026036625/cava-20260419.htm";

// A CAVA-shaped mix: filing-citable quantitative claims + genuinely external ones (the ceiling cases).
const CLAIMS = [
  "Revenue increased 32% year over year to $438 million in Q1 2026",
  "Same Restaurant Sales grew 9.7%, driven by 6.8% traffic growth",
  "CAVA Restaurant-Level Profit Margin was 25.1% in the quarter",
  "Operating cash flow was $64 million",
  "The company opened net new CAVA restaurants during the period",
  "Full-year same restaurant sales guidance was raised to 4.5% to 6.5%",
  "Diluted EPS was $0.20 for the quarter",
  "General and administrative expense leveraged as a percentage of revenue",
  "There is an unresolved $2.2 billion insider-trading allegation against founders and board",
  "The consensus sell-side price target is approximately $84.70",
  "Morningstar assigns CAVA an economic moat rating of none",
  "Sweetgreen's Infinite Kitchen automation pressures CAVA's competitive position",
];

async function main() {
  process.stdout.write(`Fetching CAVA 10-Q … `);
  const res = await fetch(FILING_URL, { headers: { "User-Agent": "investing-together/0.1 brokentymr@gmail.com" } });
  const html = res.ok ? await res.text() : "";
  console.log(`${res.status} (${html.length} bytes)`);

  const pplx = new PerplexityClient();
  const externalAsk = async (claim: string) => {
    const a = await pplx.askText({
      question: `For CAVA Group (CAVA), give ONE specific, currently-sourced fact that establishes: "${claim}". Include the exact figure/date and a source URL.`,
      maxTokens: 400, purpose: "verify.bind.external",
    }).catch(() => null);
    return a?.ok && a.text ? { text: a.text, url: a.citations[0] ?? null } : null;
  };

  // Baseline: pretend the verifier left every claim "unverified" (the worst case the closer must fix).
  const before = groundedCoverage(
    { recommendation: "review", confidence: 0.6, verdicts: CLAIMS.map(() => ({ status: "unverified" as const, citation: "" })) },
    { requireCitation: true },
  );
  console.log(`\nBEFORE closer: coverage ${(before.coverage * 100).toFixed(0)}% (0/${before.total})\n`);

  const results = await bindClaims(CLAIMS, {
    filing: { text: html, label: "10-Q 0001628280-26-036625" },
    externalAsk,
    perClaimExternalQueries: DESK_CONFIG.perClaimExternalQueries,
    minOverlap: DESK_CONFIG.bindMinKeywordOverlap,
  });

  console.log("PER-CLAIM BINDING:");
  for (const r of results) {
    const tag = r.status === "supported" ? "✓ bound" : "· unverifiable";
    console.log(`  ${tag}  ${r.claim.slice(0, 68)}`);
    console.log(`           ↳ ${r.citation ? r.citation.slice(0, 110) : r.source}`);
  }

  // After: map bind results back onto verdicts (supported+citation, or unverifiable → drop from denom).
  const verdicts = results.map((r) =>
    r.status === "supported"
      ? { status: "supported" as const, citation: r.citation }
      : { status: "unverified" as const, citation: "", unverifiable: true },
  );
  const after = groundedCoverage({ recommendation: "review", confidence: 0.6, verdicts }, { requireCitation: true });
  const bound = results.filter((r) => r.status === "supported").length;
  const unver = results.filter((r) => r.status === "unverifiable").length;
  console.log(`\nAFTER closer: coverage ${(after.coverage * 100).toFixed(0)}% (${after.supported}/${after.total}); ${bound} bound, ${unver} unverifiable (dropped from denominator + surfaced)`);
  console.log(`Grounding bar ${(DESK_CONFIG.minGroundedCoverage * 100).toFixed(0)}% → ${after.coverage >= DESK_CONFIG.minGroundedCoverage ? "CLEARS ✓" : "still short"}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
