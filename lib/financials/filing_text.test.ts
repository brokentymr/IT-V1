import { describe, it, expect } from "vitest";
import { earningsReleaseExcerpt } from "./filing_text";

describe("earningsReleaseExcerpt (Layer 2)", () => {
  const release = `
    <h1>Micron Technology, Inc. Reports Results for the Third Quarter of Fiscal 2026</h1>
    <p>Micron executes transformational Strategic Customer Agreements.</p>
    ${"<p>filler paragraph about financial results and segments. </p>".repeat(200)}
    <p>The following table presents Micron's guidance for the fourth quarter of 2026: Revenue $50.0 billion &plusmn; $1.0 billion; gross margin approximately 86%.</p>
    <p>Our multi-year Strategic Customer Agreements are structured as take-or-pay with committed volumes.</p>
  `;

  it("captures the lead narrative AND the guidance + committed-volume language even when buried mid-document", () => {
    const ex = earningsReleaseExcerpt(release, 6000);
    expect(ex).toMatch(/Strategic Customer Agreements/i); // lead narrative
    expect(ex).toMatch(/guidance for the fourth quarter/i); // forward guidance (via keyword window)
    expect(ex).toMatch(/\$50\.0 billion/); // the guidance figure
    expect(ex).toMatch(/take-or-pay|committed volumes/i); // committed-volume characterization
    expect(ex.length).toBeLessThanOrEqual(6000);
  });

  it("degrades to just the lead when no keyword windows match", () => {
    const ex = earningsReleaseExcerpt("<p>Short release with no guidance section.</p>", 2000);
    expect(ex).toMatch(/Short release/);
  });
});
