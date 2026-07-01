/**
 * Engine 5 — Company Deck (spec §6.2, owner's deck reframe). The memo as a swipeable, color-coded set
 * of visual slides: one big idea per slide, the §6.2 fixed sections in order. Header + footer are built
 * deterministically (so the "Education, not advice" badge, positions, and disclosure are always present
 * and the section contract holds); the narrative slides come from the plain-language builder. The
 * slides are the visual ATOM the newsletter and short-form reuse.
 */
import { z } from "zod";
import { completeJSON } from "../llm/client";
import type { Substance } from "../content/assemble";
import { HOUSE_VOICE, glossaryBlock, recordGlossary } from "../content/plain_language";
import { disclosureFooter, EDUCATION_BADGE, positionsLine, sourceList } from "../content/disclosure";

export const Slide = z.object({
  section: z.string(),
  title: z.string(),
  headline: z.string(),
  bullets: z.array(z.string()).default([]),
  metric: z.object({ label: z.string(), value: z.string(), sub: z.string().default("") }).nullable().default(null),
  color: z.enum(["neutral", "bull", "bear", "warn", "info"]).default("neutral"),
  visual: z.enum(["title", "number", "bars", "list", "gap", "signals", "quote", "footer"]).default("list"),
});
export type Slide = z.infer<typeof Slide>;

export const DeckNarrative = z.object({
  slides: z.array(Slide).default([]),
  glossary: z.array(z.object({ term: z.string(), plain_definition: z.string() })).default([]),
});
export type DeckNarrative = z.infer<typeof DeckNarrative>;

export interface Deck { title: string; subtitle: string; slides: Slide[] }

export interface DeckBuilder { build(input: { substance: Substance; voice: string; glossary: string }): Promise<DeckNarrative> }

// The narrative sections the builder fills, in canonical §6.2 order (header/footer added by the engine).
const MIDDLE_SECTIONS = ["one_liner", "what_they_do", "numbers", "value_picture", "right", "wrong", "price", "ground_truth", "watching"] as const;

export class ClaudeDeckBuilder implements DeckBuilder {
  async build(input: { substance: Substance; voice: string; glossary: string }): Promise<DeckNarrative> {
    const s = input.substance;
    const b = (n: number) => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : `$${(n / 1e6).toFixed(0)}M`);
    const facts = [
      `Thesis: ${s.thesis.one_liner} — ${s.thesis.long_form}`,
      `Conviction ${s.thesis.conviction ?? "?"}/5. Tensions: ${s.thesis.tensions.join("; ") || "—"}. Invalidation triggers: ${s.thesis.invalidation_triggers.join("; ") || "—"}.`,
      `Key figures: ${s.numbers.map((n) => `${n.label} ${n.unit === "USD/shares" ? n.value.toFixed(2) : b(n.value)}${n.yoy_pct != null ? ` (YoY ${(n.yoy_pct * 100).toFixed(1)}%)` : ""}`).join("; ") || "—"}`,
      s.scenario ? `Scenario (next ${s.scenario.target_period ?? "period"}): revenue P10/P50/P90 ${b(s.scenario.revenue!.p10)}/${b(s.scenario.revenue!.p50)}/${b(s.scenario.revenue!.p90)}; P(beat) ${s.scenario.beat_rev ?? "—"}. Watch: ${s.scenario.watch_items.join("; ")}` : "No scenario.",
      s.drivers.length ? `Drivers: ${s.drivers.map((d) => `${d.name} (${d.direction})`).join("; ")}` : "",
      s.sentiment ? `Sentiment gap: crowd ${s.sentiment.gap_direction} fundamentals (${s.sentiment.gap_magnitude}). ${s.sentiment.gap_rationale} Ground momentum: ${s.sentiment.ground_momentum}` : "No sentiment read.",
      s.signals.length ? `Recent price signals: ${s.signals.map((x) => `${x.kind}${x.price ? ` ${x.price}` : ""}`).join(", ")}` : "No live signals.",
      `Rolling outlook: ${s.rolling_outlook || "—"}. Open areas: ${s.open_areas.map((a) => a.title).join("; ") || "—"}.`,
    ].filter(Boolean).join("\n");

    const prompt = `${input.voice}${input.glossary}

You are building a swipeable DECK for ${s.company.legal_name} (${s.company.ticker ?? "unlisted"}). One BIG idea per slide,
color-coded, plain but substantive. Produce exactly these slides in this order, using the given "section" key:
- one_liner: the thesis in a single plain sentence (visual "quote").
- what_they_do: the business in plain language (visual "list").
- numbers: the 3-6 figures that matter, each with a one-line plain meaning (visual "number", put the headline figure in "metric").
- value_picture: bear / base / bull as what makes it look cheap, fair, or rich, in plain terms (visual "bars").
- right: what could go right — catalysts (visual "list", color "bull").
- wrong: what could go wrong — tensions + the named invalidation triggers (visual "list", color "bear").
- price: where price is now vs the value picture, signals in plain words (visual "signals").
- ground_truth: the sentiment read and the crowd-vs-fundamentals gap, plainly (visual "gap").
- watching: what we're watching — invalidation triggers + current outlook (visual "list", color "warn").
For each slide: a short "title", the "headline" (the one big idea, 1 sentence), up to 4 "bullets", a "color"
(bull=constructive, bear=risk, warn=caution, info=context, neutral), and the "visual" as noted. Also return any
jargon you had to define as glossary {term, plain_definition}.

SUBSTANCE:
${facts}

Return JSON: {"slides": [{"section","title","headline","bullets":[..],"metric":{"label","value","sub"}|null,"color","visual"}], "glossary": [{"term","plain_definition"}]}`;
    return completeJSON({ prompt, schema: DeckNarrative, model: "claude-sonnet-4-6", purpose: "content.deck", maxTokens: 4500 });
  }
}

/** Build the full deck: deterministic header + ordered narrative slides + deterministic footer. */
export async function buildDeck(substance: Substance, builder: DeckBuilder = new ClaudeDeckBuilder()): Promise<Deck> {
  const narrative = await builder.build({ substance, voice: HOUSE_VOICE, glossary: await glossaryBlock() });
  if (narrative.glossary.length) await recordGlossary(narrative.glossary);

  const header: Slide = {
    section: "header", title: `${substance.company.ticker ?? substance.company.legal_name}`,
    headline: substance.company.legal_name,
    bullets: [
      `${substance.company.ticker ?? "unlisted"} · ${substance.company.sector ?? "—"} · ${substance.company.listing}`,
      `Snapshot ${substance.as_of} · ${substance.cycle_label}`,
      EDUCATION_BADGE, positionsLine(substance.company.positions_held),
    ],
    metric: null, color: "info", visual: "title",
  };

  const bySection = new Map(narrative.slides.map((sl) => [sl.section, sl]));
  const middle = MIDDLE_SECTIONS.map((sec) => bySection.get(sec)).filter((sl): sl is Slide => !!sl);

  const footer: Slide = {
    section: "footer", title: "Sources & disclosure", headline: "Where this comes from",
    bullets: [disclosureFooter(substance), ...sourceList(substance).map((x) => `[${x.n}] ${x.origin}${x.title ? ` — ${x.title}` : ""}`)],
    metric: null, color: "neutral", visual: "footer",
  };

  return { title: `${substance.company.ticker ?? substance.company.legal_name} — ${substance.thesis.one_liner}`, subtitle: `${substance.as_of} · ${substance.cycle_label}`, slides: [header, ...middle, footer] };
}
