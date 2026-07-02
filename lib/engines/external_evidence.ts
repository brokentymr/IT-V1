/**
 * External retrieved evidence (grounding v2 — W2 transcripts + W7 third-party data).
 *
 * No raw transcript or market-data feed exists yet, so these are Perplexity-sourced WITH citations —
 * an honest interim. Both add sourced passages to the desk's evidence so the verifier can cite them
 * (W4), grounding claims about management commentary, pricing/ASPs, capacity, and market share that the
 * filing alone doesn't establish. Upgrade to real feeds later without changing the call sites.
 */

export interface AskText {
  askText(input: { question: string; maxTokens?: number; purpose?: string }): Promise<{ ok: boolean; text?: string } | null>;
}

export interface ExternalEvidence {
  label: string;
  text: string;
}

/** W2 — earnings-call highlights: management's quantified commentary on demand, pricing, capacity, guidance.
 *  Targets the specific gap the 10-Q/XBRL cannot fill: management's total COMMITTED-VOLUME characterization
 *  (which, unlike the narrow ASC 606 RPO, includes the market/price-band agreements), the forward guidance,
 *  and the reasoning behind it — the narrative the desk must read to judge forward guidance. */
export async function fetchTranscript(perplexity: AskText, company: { legal_name: string; ticker: string | null }): Promise<ExternalEvidence | null> {
  const a = await perplexity
    .askText({
      question: `From ${company.legal_name} (${company.ticker ?? "n/a"})'s MOST RECENT earnings call (prepared remarks AND Q&A), report management's SPECIFIC, quantified statements on:
1. FORWARD GUIDANCE for next quarter/year (revenue, margin, EPS ranges) and the KEY ASSUMPTIONS behind it.
2. Total COMMITTED VOLUME / long-term or strategic customer agreements — the number of agreements, the aggregate committed dollar value or volume, and how it is characterized (e.g. take-or-pay, minimum pricing). Distinguish this from the GAAP "remaining performance obligations" figure if both are mentioned.
3. Demand / bookings / backlog, pricing and ASP direction, capacity / utilization / sold-out status.
4. The NARRATIVE management is painting about durability vs cyclicality.
Give exact figures, dates, and who said them (CEO/CFO). Quote where possible. Cite sources.`,
      maxTokens: 1100,
      purpose: "research.transcript",
    })
    .catch(() => null);
  return a?.ok && a.text ? { label: "Earnings-call: guidance, committed-volume & narrative (transcript — sourced, cite as 'transcript')", text: a.text } : null;
}

/** W7 — third-party market/pricing data: ASP trends and market share from TrendForce/Gartner/IDC-type sources. */
export async function fetchMarketData(perplexity: AskText, company: { legal_name: string; ticker: string | null; gics_sector: string | null }): Promise<ExternalEvidence | null> {
  const a = await perplexity
    .askText({
      question: `For ${company.legal_name} (${company.ticker ?? "n/a"}) in the ${company.gics_sector ?? "relevant"} sector: current THIRD-PARTY market data — product pricing / ASP trends and market-share figures from sources like TrendForce, Gartner, or IDC. Cite the source and date for each figure. Be concise.`,
      maxTokens: 600,
      purpose: "research.market_data",
    })
    .catch(() => null);
  return a?.ok && a.text ? { label: "Third-party market/pricing data (sourced, cite as 'market data')", text: a.text } : null;
}

/** Assemble the fetched items into one evidence block; "" when nothing came back. */
export function externalBlock(items: Array<ExternalEvidence | null>): string {
  const ok = items.filter((x): x is ExternalEvidence => !!x && !!x.text?.trim());
  return ok.length ? ok.map((e) => `${e.label}:\n${e.text}`).join("\n\n") : "";
}
