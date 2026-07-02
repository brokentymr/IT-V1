/**
 * Canonical fact registry (control P9, pure). Before the spider is generated we materialize the handful of
 * canonical numbers the reader will meet — the up-to-6 fundamentals figures, the scenario bands + P(beat),
 * the sentiment gap magnitude, and recent price signals — each rendered ONCE, in full, with the SAME
 * formatters the deck (b()/toFixed) and podcast use, plus its source ref. renderRegistryBlock() hands this
 * to each builder as a prompt instruction: render a fact in full WITH its citation the first time, then
 * reference it or bring a new angle rather than restating the identical figure. Degrades gracefully when
 * scenario / sentiment / signals are absent. Types are local (not added to lib/types.ts).
 */
import type { Substance } from "./assemble";
import { extractNumericTokens } from "./dedup_lint";
import { FACT_REGISTRY_CONFIG, type FactRegistryConfig } from "../config/content";

export interface Fact {
  key: string;
  label: string;
  canonical_statement: string;
  value_tokens: string[];
  source_ref: string | null;
  used: boolean;
}

export interface FactRegistry {
  facts: Fact[];
  byKey: Map<string, Fact>;
}

// Shared formatters — identical to deck.ts b() and the USD/shares toFixed(2) so the registry's rendering of a
// number is byte-for-byte what a builder would otherwise produce (keeping the dedup lint honest).
const b = (n: number): string => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : `$${(n / 1e6).toFixed(0)}M`);
const money = (value: number, unit: string): string => (unit === "USD/shares" ? value.toFixed(2) : b(value));
const yoy = (pct: number | null): string => (pct != null ? ` (YoY ${(pct * 100).toFixed(1)}%)` : "");

function makeFact(key: string, label: string, statement: string, sourceRef: string | null): Fact {
  return { key, label, canonical_statement: statement, value_tokens: extractNumericTokens(statement), source_ref: sourceRef, used: false };
}

/** Materialize the canonical numeric facts from an approved Substance. */
export function buildFactRegistry(substance: Substance, cfg: FactRegistryConfig = FACT_REGISTRY_CONFIG): FactRegistry {
  const facts: Fact[] = [];
  const primaryRef = substance.provenance[0]?.ref ?? null; // coarse: the snapshot's first cited source

  // 1) Fundamentals — up to `maxFundamentals` figures (assemble.ts already sliced to 6).
  for (const n of substance.numbers.slice(0, cfg.maxFundamentals)) {
    facts.push(makeFact(`fundamentals.${n.label}`, n.label, `${n.label} of ${money(n.value, n.unit)}${yoy(n.yoy_pct)}`, primaryRef));
  }

  // 2) Scenario bands + P(beat) — degrade gracefully when scenario is null.
  const sc = substance.scenario;
  if (sc) {
    const period = sc.target_period ? `Next ${sc.target_period}` : "Next period";
    if (sc.revenue) {
      facts.push(makeFact("scenario.revenue", "Revenue scenario", `${period} revenue scenario: ${b(sc.revenue.p10)} (P10) / ${b(sc.revenue.p50)} (P50) / ${b(sc.revenue.p90)} (P90)`, primaryRef));
    }
    if (sc.eps) {
      facts.push(makeFact("scenario.eps", "EPS scenario", `${period} EPS scenario: ${sc.eps.p10.toFixed(2)} (P10) / ${sc.eps.p50.toFixed(2)} (P50) / ${sc.eps.p90.toFixed(2)} (P90)`, primaryRef));
    }
    if (sc.beat_rev != null) {
      facts.push(makeFact("scenario.beat_rev", "P(beat revenue)", `Probability of beating the revenue base case: ${sc.beat_rev}`, primaryRef));
    }
  }

  // 3) Sentiment gap magnitude — degrade gracefully when sentiment is null.
  const sent = substance.sentiment;
  if (sent) {
    facts.push(makeFact("sentiment.gap", "Sentiment gap", `Crowd sentiment sits ${sent.gap_direction} of fundamentals (${sent.gap_magnitude} gap)`, null));
  }

  // 4) Recent price signals.
  for (const [i, s] of substance.signals.slice(0, cfg.maxSignals).entries()) {
    if (s.price == null) continue;
    facts.push(makeFact(`signal.${i}`, `Price signal (${s.kind})`, `Recent ${s.kind} price signal at ${s.price.toFixed(2)} (${s.ts.slice(0, 10)})`, null));
  }

  return { facts, byKey: new Map(facts.map((f) => [f.key, f])) };
}

/** Mark a fact used; returns true if this was its FIRST use (the render-in-full-with-citation moment). */
export function markUsed(reg: FactRegistry, key: string): boolean {
  const f = reg.byKey.get(key);
  if (!f) return false;
  const first = !f.used;
  f.used = true;
  return first;
}

/** A prompt block listing the canonical facts + the first-use / reference-or-new-angle instruction. Empty
 *  string when there are no facts (so builders that concatenate it are unaffected). */
export function renderRegistryBlock(reg: FactRegistry): string {
  if (!reg.facts.length) return "";
  const lines = reg.facts.map((f, i) => `  [F${i + 1}] ${f.canonical_statement}${f.source_ref ? "  (cite its source)" : ""}`).join("\n");
  return `CANONICAL FACTS (shared across the deck, newsletter, and short-form — do not talk down to the reader by repeating them):
${lines}
Rule: the FIRST time one of these figures appears in this piece, render it in full and cite its source; AFTER that, reference it briefly or bring a NEW angle — do NOT restate the identical number verbatim.
`;
}
