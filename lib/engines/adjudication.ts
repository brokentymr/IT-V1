/**
 * Adjudication (pipeline upgrade — docs/UPGRADE-pipeline-rearchitecture.md §4).
 *
 * The head of research must RULE on disagreement, not average it. In the Micron run the sector lens
 * confidently validated a figure three other lenses called impossible, and the synthesizer blended
 * toward "unverified" instead of ruling. This module surfaces WHERE the lenses diverge and hands the
 * synthesizer the per-lens claims so it can reconcile the specific conflict: fact disputes settled
 * against the evidence, judgment disputes owned as explicit key debates with a lean. Pure — no LLM.
 */

export interface LensLike {
  lens: string;
  confidence: number;
  summary?: string;
  risks?: string[];
  claims?: Array<{ statement: string; grounded?: boolean; confidence: number }>;
}

export interface Divergence {
  spread: number; // max - min lens confidence
  lowest: { lens: string; confidence: number } | null;
  highest: { lens: string; confidence: number } | null;
  diverges: boolean;
}

/** How far apart the lenses are. A wide confidence spread means a real disagreement the synthesizer
 *  must reconcile rather than average. */
export function panelDivergence(panel: LensLike[], threshold = 0.25): Divergence {
  if (panel.length < 2) return { spread: 0, lowest: null, highest: null, diverges: false };
  const sorted = [...panel].sort((a, b) => a.confidence - b.confidence);
  const lowest = sorted[0];
  const highest = sorted[sorted.length - 1];
  const spread = highest.confidence - lowest.confidence;
  return {
    spread,
    lowest: { lens: lowest.lens, confidence: lowest.confidence },
    highest: { lens: highest.lens, confidence: highest.confidence },
    diverges: spread >= threshold,
  };
}

/** Instruction injected into synthesis when the lenses disagree materially; "" when they're aligned. */
export function divergenceNote(panel: LensLike[], threshold = 0.25): string {
  const d = panelDivergence(panel, threshold);
  if (!d.diverges || !d.lowest || !d.highest) return "";
  return `⚠ THE LENSES DISAGREE MATERIALLY (${d.highest.lens} at ${(d.highest.confidence * 100).toFixed(0)}% vs ${d.lowest.lens} at ${(d.lowest.confidence * 100).toFixed(0)}%). Do NOT average this away. Identify the specific point(s) of disagreement. If it is a matter of FACT (e.g. is a figure real, what is the market share), RULE on it against the evidence and say which lens is right and why. If it is a matter of JUDGMENT (e.g. is a margin durable), record it as a key_debate with the bull case, the bear case, and YOUR lean.`;
}

/** A compact digest of each lens's material claims — with the grounded/prior flag and confidence —
 *  so the synthesizer sees and reconciles fact disputes instead of only reading summaries. */
export function claimsDigest(panel: LensLike[], perLens = 3): string {
  return panel
    .map((p) => {
      const cs = (p.claims ?? [])
        .slice(0, perLens)
        .map((c) => `    - [${c.grounded ? "grounded" : "prior"}, ${(c.confidence * 100).toFixed(0)}%] ${c.statement}`)
        .join("\n");
      return `  ${p.lens} (conf ${(p.confidence * 100).toFixed(0)}%):\n${cs || "    (no material claims)"}`;
    })
    .join("\n");
}
