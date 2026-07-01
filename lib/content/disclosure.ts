/**
 * Disclosure + positions (spec §6). Auto-appended to every audience consumable: the "Education, not
 * advice" stance, any positions held, and the standard disclaimer. Never omitted.
 */
import type { Substance } from "./assemble";

export const EDUCATION_BADGE = "Education, not advice";

export function positionsLine(positionsHeld: unknown[]): string {
  if (!Array.isArray(positionsHeld) || positionsHeld.length === 0) return "Positions: none disclosed.";
  const names = positionsHeld.map((p) => (typeof p === "string" ? p : (p as { ticker?: string; symbol?: string })?.ticker ?? (p as { symbol?: string })?.symbol ?? JSON.stringify(p))).filter(Boolean);
  return names.length ? `Positions held: ${names.join(", ")}.` : "Positions: none disclosed.";
}

export function disclosureFooter(s: Substance): string {
  return [
    `${EDUCATION_BADGE}. This is our own research, shared for learning — not financial advice and not a recommendation to buy or sell any security.`,
    positionsLine(s.company.positions_held),
    "Figures are drawn from public filings and the sources listed; we may be wrong. Always do your own research.",
  ].join(" ");
}

/** The provenance source list, plain-rendered (for footers / "Sources" sections). */
export function sourceList(s: Substance): Array<{ n: number; origin: string; url: string | null; title: string | null }> {
  return s.provenance.map((p, i) => ({ n: i + 1, origin: p.origin, url: p.url, title: p.title }));
}
