/**
 * Content dedup lint (control P9, pure). The spider (deck → newsletter → short-form) repeatedly renders the
 * SAME canonical numbers; when the exact figure is re-stated verbatim in every ring the reader feels talked
 * down to ("you're showing your work too much"). This pass extracts numeric tokens from each assembled
 * section, normalizes near-equal renderings ($85.0B ≡ $85B), and flags any figure that appears more than the
 * configured number of times — ADVISORY only (generate.ts never throws on it). Config lives in lib/config/content.ts.
 */
import type { ContentLintConfig } from "../config/content";

export interface LintFinding { token: string; count: number; sections: string[] }
export interface LintReport { findings: LintFinding[]; flaggedCount: number }

/**
 * Pull the numeric tokens out of a block of rendered content: currency ($85.0B, $21M, $1.50, $1,200),
 * percentages (5.0%, 22%, -0.5%), scenario bands (P10/P50/P90), bare probabilities/decimals (0.53, 1.50),
 * and large plain integers. Matched spans are blanked as they are consumed so a currency figure's digits
 * aren't double-counted as a plain integer.
 */
export function extractNumericTokens(text: string): string[] {
  const out: string[] = [];
  let work = text;
  const grab = (re: RegExp): void => {
    work = work.replace(re, (m) => {
      out.push(m);
      return " ".repeat(m.length);
    });
  };
  grab(/P(?:10|50|90)\b/gi);                       // scenario band labels
  grab(/\$\d[\d,]*(?:\.\d+)?\s?[BMK]?/gi);          // currency, incl. $85.0B / $21M / $1.50 / $1,200
  grab(/-?\d[\d,]*(?:\.\d+)?%/g);                   // percentages
  grab(/\b\d+\.\d+\b/g);                            // decimals incl. probabilities (0.53) and prices (1.50)
  grab(/\b\d[\d,]*\b/g);                            // remaining plain integers
  return out;
}

/** Canonicalize a token so near-equal renderings collapse: lowercase, strip commas, trim trailing zeros
 *  in a decimal fraction ($85.0B → $85b, 1.50 → 1.5, 5.0% → 5%). */
export function normalizeNumeric(token: string): string {
  let t = token.toLowerCase().replace(/,/g, "");
  t = t.replace(/(\d+)\.(\d+)/g, (_m, intp: string, frac: string) => {
    const f = frac.replace(/0+$/, "");
    return f ? `${intp}.${f}` : intp;
  });
  return t;
}

/** True when a normalized token is too generic to flag: an explicitly ignored token, a calendar year
 *  (when ignoreYears), or a small plain integer below cfg.minInteger. */
function isIgnorable(norm: string, cfg: ContentLintConfig): boolean {
  const ignore = new Set(cfg.ignoreTokens.map(normalizeNumeric));
  if (ignore.has(norm)) return true;
  if (/^\d+$/.test(norm)) {
    if (cfg.ignoreYears && /^(?:19|20)\d{2}$/.test(norm)) return true;
    if (Number(norm) < cfg.minInteger) return true;
  }
  return false;
}

/**
 * Lint the assembled spider. `sections` is the flattened plain text of each ring ({label, text}); a numeric
 * token is flagged when its total occurrences across all sections exceed cfg.maxNumericRepeats. Findings carry
 * the normalized token, its total count, and the distinct sections it appears in.
 */
export function lintAssembledReport(sections: Array<{ label: string; text: string }>, cfg: ContentLintConfig): LintReport {
  const acc = new Map<string, { count: number; sections: Set<string> }>();
  for (const sec of sections) {
    for (const raw of extractNumericTokens(sec.text)) {
      const norm = normalizeNumeric(raw);
      if (isIgnorable(norm, cfg)) continue;
      const entry = acc.get(norm) ?? { count: 0, sections: new Set<string>() };
      entry.count += 1;
      entry.sections.add(sec.label);
      acc.set(norm, entry);
    }
  }
  const findings: LintFinding[] = [];
  for (const [token, entry] of acc) {
    if (entry.count > cfg.maxNumericRepeats) findings.push({ token, count: entry.count, sections: [...entry.sections] });
  }
  findings.sort((a, b) => b.count - a.count || a.token.localeCompare(b.token));
  return { findings, flaggedCount: findings.length };
}
