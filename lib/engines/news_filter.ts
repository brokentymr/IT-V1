/**
 * Entity gate + feed suppression (control P8) — pure, deterministic, no I/O.
 *
 * These helpers decide, BEFORE any LLM classification is spent, whether a headline plausibly refers to
 * the company at all (the entity gate) and, after classification, whether a low-value note should be
 * hidden from the reader-facing feed (feed suppression). All matching is word-boundary and
 * case-insensitive so a short term like "mu" does NOT match inside "Museum".
 */
import type { EntityGateConfig } from "../config/entity_gate";

export interface GateCompany {
  legalName: string;
  ticker: string;
  exchange?: string | null;
  gicsSector?: string | null;
}

export interface GateItem {
  title: string;
  snippet?: string | null;
}

export interface EntityGateResult {
  passed: boolean;
  reason?: "known_collision" | "insufficient_signals";
  matchedTerm?: string;
}

/** Word-boundary, case-insensitive presence test. `$MU` matches on "$MU" but "mu" does NOT match "Museum". */
export function hasWord(text: string, term: string): boolean {
  const t = (term ?? "").trim();
  if (!t) return false;
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A "word" boundary here means: not flanked by another alphanumeric character. This lets a leading
  // `$` (a non-alnum) sit before the token so cashtags match, while blocking sub-word matches.
  return new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, "i").test(text ?? "");
}

/** Distinctive legal-name tokens with corporate suffixes (Inc/Corp/Technology/...) stripped. */
function distinctiveNameTokens(legalName: string, cfg: EntityGateConfig): string[] {
  const stop = new Set(cfg.nameSuffixStopwords.map((s) => s.toLowerCase().replace(/[.]/g, "")));
  return (legalName ?? "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .filter((w) => w.length >= 3 && !stop.has(w.toLowerCase()));
}

/** A ticker is collision-prone iff it is short OR on the curated denylist. Everything else is safe. */
export function isCollisionProne(ticker: string, cfg: EntityGateConfig): boolean {
  const t = (ticker ?? "").trim().toUpperCase();
  if (!t) return false;
  return t.length <= cfg.maxCollisionTickerLen || cfg.collisionTickers.includes(t);
}

/**
 * Count the distinctive company signals a headline carries: (1) a suffix-stripped legal-name token,
 * (2) a `$TICKER` cashtag OR an exchange mention, (3) a GICS sector-defining term. Returns the matched
 * signal labels so callers can log why an item did (or did not) clear the gate.
 */
export function countEntitySignals(item: GateItem, company: GateCompany, cfg: EntityGateConfig): { signals: string[] } {
  const text = `${item.title ?? ""} ${item.snippet ?? ""}`;
  const signals: string[] = [];

  const nameHit = distinctiveNameTokens(company.legalName, cfg).find((tok) => hasWord(text, tok));
  if (nameHit) signals.push(`name:${nameHit}`);

  const ticker = (company.ticker ?? "").trim().toUpperCase();
  if (ticker && hasWord(text, `$${ticker}`)) signals.push("cashtag");
  else if (company.exchange && hasWord(text, company.exchange)) signals.push(`exchange:${company.exchange}`);

  const syn = company.gicsSector ? cfg.sectorTermSynonyms[company.gicsSector] ?? [] : [];
  const sectorHit = syn.find((term) => hasWord(text, term));
  if (sectorHit) signals.push(`sector:${sectorHit}`);

  return { signals };
}

/**
 * The entity gate. Non-collision-prone tickers pass UNCONDITIONALLY (strict no-op). For collision-prone
 * tickers: a headline matching a learned denylist phrase fails as `known_collision`; otherwise it must
 * carry >= minEntitySignals distinctive signals or it fails as `insufficient_signals`.
 */
export function entityGate(
  item: GateItem,
  company: GateCompany,
  knownCollisionTerms: string[],
  cfg: EntityGateConfig,
): EntityGateResult {
  if (!isCollisionProne(company.ticker, cfg)) return { passed: true };

  const text = `${item.title ?? ""} ${item.snippet ?? ""}`;
  for (const term of knownCollisionTerms) {
    if (hasWord(text, term)) return { passed: false, reason: "known_collision", matchedTerm: term };
  }

  const { signals } = countEntitySignals(item, company, cfg);
  if (signals.length < cfg.minEntitySignals) return { passed: false, reason: "insufficient_signals" };
  return { passed: true };
}

/** Feed/scoring suppression: a `category:'other'` note below the importance floor is hidden. */
export function isFeedSuppressed(category: string, importanceScore: number, cfg: EntityGateConfig): boolean {
  return category === "other" && importanceScore < cfg.otherCategoryImportanceFloor;
}
