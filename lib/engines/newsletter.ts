/**
 * Engine 7 — Newsletter (spec §6.6, owner's "long-form" ring). A conversational, value-focused
 * discussion of the company outlook and positioning, in the house voice. It INSETS the deck's slides
 * as visuals via {{slide:<section>}} markers (the render layer inlines them). Fixed §6.6 sections;
 * disclosure + sources are appended deterministically so they are never missing.
 */
import { z } from "zod";
import { completeJSON } from "../llm/client";
import type { Substance } from "../content/assemble";
import type { Deck } from "./deck";
import { HOUSE_VOICE, glossaryBlock, recordGlossary } from "../content/plain_language";
import { disclosureFooter, sourceList } from "../content/disclosure";

export const NewsletterDraft = z.object({
  title: z.string(),
  opening: z.string(),
  body: z.string(),          // the value picture / right / wrong / price / ground truth as prose, with {{slide:...}} markers
  watching: z.string(),
  embedded_slides: z.array(z.string()).default([]),
  glossary: z.array(z.object({ term: z.string(), plain_definition: z.string() })).default([]),
});
export type NewsletterDraft = z.infer<typeof NewsletterDraft>;

export interface Newsletter { title: string; markdown: string; embedded_slides: string[] }

export interface NewsletterBuilder { build(input: { substance: Substance; deckSections: string[]; voice: string; glossary: string }): Promise<NewsletterDraft> }

export class ClaudeNewsletterBuilder implements NewsletterBuilder {
  async build(input: { substance: Substance; deckSections: string[]; voice: string; glossary: string }): Promise<NewsletterDraft> {
    const s = input.substance;
    const prompt = `${input.voice}${input.glossary}

Write a NEWSLETTER for ${s.company.legal_name} (${s.company.ticker ?? "unlisted"}) — conversational, a discussion of the
outlook and positioning. Lead with VALUE and honest risk. Keep it TIGHT and readable — aim for ~500-800 words total across
opening + body + watching (a focused read, not exhaustive). You may INSET the companion deck's slides as visuals by
placing a marker on its own line: {{slide:SECTION}} where SECTION is one of: ${input.deckSections.join(", ")}. Use 2-4 of them
where a visual helps (e.g. the value picture, the numbers, the sentiment gap).

Substance:
- Thesis: ${s.thesis.one_liner} — ${s.thesis.long_form}
- Value picture inputs: ${s.scenario ? `revenue P10/P50/P90 and P(beat) ${s.scenario.beat_rev ?? "—"}, watch ${s.scenario.watch_items.join("; ")}` : "n/a"}; drivers ${s.drivers.map((d) => `${d.name} (${d.direction})`).join("; ") || "n/a"}
- What could go right/wrong: tensions ${s.thesis.tensions.join("; ") || "—"}; invalidation ${s.thesis.invalidation_triggers.join("; ") || "—"}
- Where price is: ${s.signals.map((x) => `${x.kind}${x.price ? ` ${x.price}` : ""}`).join(", ") || "no live signals"}
- Ground truth: ${s.sentiment ? `crowd ${s.sentiment.gap_direction} fundamentals (${s.sentiment.gap_magnitude}); ${s.sentiment.gap_rationale}` : "no sentiment read"}
- Watching: ${s.thesis.invalidation_triggers.join("; ")}; outlook ${s.rolling_outlook || "—"}

Return JSON: {"title","opening","body","watching","embedded_slides":["section",...],"glossary":[{"term","plain_definition"}]}`;
    return completeJSON({ prompt, schema: NewsletterDraft, model: "claude-sonnet-4-6", purpose: "content.newsletter", maxTokens: 5000 });
  }
}

/** Assemble the final Substack-ready Markdown with fixed §6.6 sections + auto-appended disclosure/sources. */
export async function buildNewsletter(substance: Substance, deck: Deck, builder: NewsletterBuilder = new ClaudeNewsletterBuilder()): Promise<Newsletter> {
  const draft = await builder.build({ substance, deckSections: deck.slides.map((sl) => sl.section), voice: HOUSE_VOICE, glossary: await glossaryBlock() });
  if (draft.glossary.length) await recordGlossary(draft.glossary);

  const sources = sourceList(substance).map((x) => `${x.n}. ${x.origin}${x.title ? ` — ${x.title}` : ""}${x.url ? ` (${x.url})` : ""}`).join("\n");
  const markdown = [
    `# ${draft.title}`,
    draft.opening,
    "## The company",
    draft.body,
    "## What we're watching",
    draft.watching,
    "---",
    `_${disclosureFooter(substance)}_`,
    "## Sources",
    sources || "_—_",
  ].join("\n\n");

  return { title: draft.title, markdown, embedded_slides: draft.embedded_slides };
}
