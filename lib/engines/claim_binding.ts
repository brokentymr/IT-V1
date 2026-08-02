/**
 * Claim → citation binding (grounding coverage-closer). The desk's grounding gate holds a thesis when
 * too few load-bearing claims are backed by a CITED source. Historically the deepen loop chased
 * confidence and never drove coverage on purpose, and enrichment dumped an undifferentiated evidence
 * blob the verifier had to re-scan — so claims whose facts sit right in the 10-Q (SSS, margins, unit
 * counts, guidance) stayed "unverified" for want of an explicit citation.
 *
 * This module binds ONE claim at a time to a specific citation: the filing we already hold FIRST
 * (free, deterministic, where most quantitative claims live), then a targeted external query for what
 * the filing can't cover. A claim actively tried against every wired source and still unfindable is
 * returned `unverifiable` — the caller drops it from the coverage denominator and surfaces it as an
 * explicit gap, rather than letting one genuinely-private fact sink an otherwise well-grounded name.
 *
 * The filing matcher is pure/deterministic (no LLM); the external step is injected, so the whole thing
 * is testable without network.
 */

const STOPWORDS = new Set([
  "about", "above", "after", "again", "against", "their", "there", "these", "those", "which", "while",
  "would", "could", "should", "being", "between", "during", "before", "because", "into", "over", "under",
  "than", "then", "that", "this", "with", "from", "have", "has", "had", "was", "were", "will", "the",
  "and", "for", "are", "but", "not", "you", "your", "its", "it's", "they", "them", "our", "vs",
]);

/** Salient tokens for matching: content words (≥4 chars, non-stopword) + numeric/percent tokens, which
 *  carry most of the signal in a financial claim ("9.7%", "438", "25.1"). Lowercased + de-duplicated. */
export function salientTokens(claim: string): string[] {
  // Split on any non-letter (so "same-restaurant" → "same","restaurant" and matches the filing's
  // "Same Restaurant Sales"); keep runs of ≥4 letters that aren't stopwords.
  const words = (claim.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOPWORDS.has(w));
  // Numbers, with and without the %/$ so "9.7%" matches a bare "9.7" in the filing text.
  const numbers = (claim.match(/\$?\d[\d,]*\.?\d*%?/g) ?? [])
    .map((n) => n.replace(/[$,%]/g, "").replace(/\.0+$/, ""))
    .filter((n) => n.length > 0 && n !== "0");
  return [...new Set([...words, ...numbers])];
}

const stripTags = (s: string): string => s.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ");

export interface FilingMatch { passage: string; citation: string; overlap: number }

/**
 * Best filing passage backing a claim. Slides a window over the (tag-stripped) filing text, scores each
 * by the fraction of the claim's salient tokens it contains, and returns the strongest window above
 * `minOverlap` with a short quoted snippet as the citation. Deterministic. null when nothing clears the bar.
 */
export function matchFilingPassage(
  claim: string,
  filingText: string,
  opts: { minOverlap: number; label: string; windowChars?: number; scanLimit?: number },
): FilingMatch | null {
  const tokens = salientTokens(claim);
  if (!tokens.length) return null;
  // Split word vs numeric tokens. A quantitative claim (has numbers) may bind ONLY to a passage that
  // carries at least one of its figures — otherwise a keyword-only match lands on the wrong sentence and
  // produces a citation that doesn't actually back the claim (false grounding, worse than honest "unverified").
  // Numeric tokens carry a claim's identity — but EXCLUDE bare 4-digit years (2025/2026 appear on nearly
  // every page, so they can't distinguish the right passage). Match a figure only when it is NOT preceded
  // by another digit, so "438" binds "438,270" / "438.3" (filings give exact figures for a rounded claim)
  // yet "64" does NOT match inside "3,648". This is what keeps a citation on the passage that truly backs it.
  const isYear = (t: string) => /^(19|20)\d\d$/.test(t);
  const nums = tokens.filter((t) => /\d/.test(t) && !isYear(t));
  const words = tokens.filter((t) => !/\d/.test(t));
  // Match a figure only at the START of a number run — not preceded by a digit, comma, or period — so
  // "438" binds "438,270" / "438.3" (a rounded claim vs the filing's exact figure) but "64" never matches
  // inside "3,648". Figures are the claim's identity, so weight a numeric hit 2× a word hit: a window
  // carrying the actual number beats a section header that merely shares vocabulary.
  const figRe = (n: string) => new RegExp(`(?<![\\d.,])${n.replace(/[.]/g, "\\.")}`);
  const numRe = nums.map(figRe);
  const text = stripTags(filingText).slice(0, opts.scanLimit ?? 500_000);
  const lower = text.toLowerCase();
  const win = opts.windowChars ?? 480;
  const step = Math.floor(win / 2);
  const denom = 2 * nums.length + words.length;
  let best: { start: number; score: number } | null = null;
  for (let start = 0; start < lower.length; start += step) {
    const chunk = lower.slice(start, start + win);
    const numHits = numRe.filter((re) => re.test(chunk)).length;
    if (nums.length > 0 && numHits === 0) continue; // quantitative claim, but this window has none of its figures
    const wordHits = words.filter((t) => chunk.includes(t)).length;
    const score = (2 * numHits + wordHits) / denom;
    if (!best || score > best.score) best = { start, score };
    if (score === 1) break;
  }
  if (!best || best.score < opts.minOverlap) return null;
  // Center the quoted snippet on the strongest figure so the citation shows the actual backing number.
  const raw = text.slice(best.start, best.start + win).trim();
  const anchor = nums.map((n) => raw.toLowerCase().search(figRe(n))).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const from = Math.max(0, anchor - 40);
  const snippet = `${from > 0 ? "…" : ""}${raw.slice(from, from + 180).replace(/\s+\S*$/, "")}…`;
  return { passage: raw, citation: `${opts.label}: "${snippet}"`, overlap: Number(best.score.toFixed(2)) };
}

export type BindStatus = "supported" | "unverifiable";
export interface BindResult { claim: string; status: BindStatus; citation: string; source: string }

export interface BindDeps {
  /** The filing we already hold — checked first (free). `text` may be raw HTML; it is tag-stripped. */
  filing?: { text: string; label: string } | null;
  /** Targeted external lookup (Perplexity), injected. Returns a sourced fact + a citation URL, or null.
   *  A result WITHOUT a url is treated as uncitable (→ contributes nothing; claim stays for the ceiling). */
  externalAsk?: ((claim: string) => Promise<{ text: string; url: string | null } | null>) | null;
  perClaimExternalQueries: number;
  minOverlap: number;
}

/**
 * Bind each claim to a citation. Filing first, then up to `perClaimExternalQueries` external lookups.
 * Every claim comes back classified: `supported` with a citation, or `unverifiable` (tried + unsourceable).
 */
export async function bindClaims(claims: string[], deps: BindDeps): Promise<BindResult[]> {
  const out: BindResult[] = [];
  for (const claim of claims) {
    // 1) Filing passage — deterministic, where most quantitative claims live.
    if (deps.filing?.text) {
      const m = matchFilingPassage(claim, deps.filing.text, { minOverlap: deps.minOverlap, label: deps.filing.label });
      if (m) { out.push({ claim, status: "supported", citation: m.citation, source: deps.filing.label }); continue; }
    }
    // 2) Targeted external lookup(s) — only what the filing can't cover; require a citable URL.
    let bound: BindResult | null = null;
    if (deps.externalAsk && deps.perClaimExternalQueries > 0) {
      for (let q = 0; q < deps.perClaimExternalQueries; q++) {
        const r = await deps.externalAsk(claim).catch(() => null);
        if (r?.text?.trim() && r.url?.trim()) {
          const snip = r.text.trim().replace(/\s+/g, " ").slice(0, 160);
          bound = { claim, status: "supported", citation: `${r.url}: "${snip}${r.text.length > 160 ? "…" : ""}"`, source: r.url };
          break;
        }
      }
    }
    out.push(bound ?? { claim, status: "unverifiable", citation: "", source: "tried: filing + external, no citable source" });
  }
  return out;
}
