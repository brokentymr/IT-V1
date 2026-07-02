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

/** W2 — earnings-call highlights: management's quantified commentary on demand, pricing, capacity, guidance. */
export async function fetchTranscript(perplexity: AskText, company: { legal_name: string; ticker: string | null }): Promise<ExternalEvidence | null> {
  const a = await perplexity
    .askText({
      question: `Summarize ${company.legal_name} (${company.ticker ?? "n/a"})'s MOST RECENT earnings call. Give management's SPECIFIC, quantified commentary on: demand / orders / backlog, pricing and ASPs, capacity / utilization, and forward guidance. Cite figures and dates. Be concise.`,
      maxTokens: 700,
      purpose: "research.transcript",
    })
    .catch(() => null);
  return a?.ok && a.text ? { label: "Earnings-call highlights (transcript — sourced, cite as 'transcript')", text: a.text } : null;
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
