/**
 * Engine 7 — Podcast episode (spec §6.4, owner's "the two of us" ring). This is about the hosts doing
 * it together: the studio collects each host's own notes on the research, and "build episode" weaves
 * BOTH note-sets + the substance into a script — attributed by author. The engine supplies SUBSTANCE
 * and a plain-language draft only; pacing, tone, and editorial belong to the hosts (no directorial
 * instructions). A spoken-disclosure block is read aloud; a facts appendix carries provenance.
 */
import { z } from "zod";
import { completeJSON } from "../llm/client";
import type { Substance } from "../content/assemble";
import { HOUSE_VOICE, glossaryBlock } from "../content/plain_language";
import { EDUCATION_BADGE, positionsLine } from "../content/disclosure";

export interface EpisodeNote { author: string; note: string }

export const Segment = z.object({
  topic: z.string(),
  point: z.string(),                      // the point in plain language
  facts: z.array(z.string()).default([]), // supporting facts/figures
  sentiment_signal_context: z.string().default(""),
  contributions: z.array(z.object({ author: z.string(), take: z.string() })).default([]), // attributed to each host's notes
});
export const EpisodeDraft = z.object({ segments: z.array(Segment).default([]) });
export type EpisodeDraft = z.infer<typeof EpisodeDraft>;

export interface PodcastScript {
  metadata: { companies: string[]; cycle_label: string; authors: string[]; spoken_disclosure: string };
  segments: z.infer<typeof Segment>[];
  facts_appendix: Array<{ figure: string; source: string }>;
}

export interface EpisodeBuilder { build(input: { substance: Substance; notes: EpisodeNote[]; voice: string; glossary: string }): Promise<EpisodeDraft> }

export class ClaudeEpisodeBuilder implements EpisodeBuilder {
  async build(input: { substance: Substance; notes: EpisodeNote[]; voice: string; glossary: string }): Promise<EpisodeDraft> {
    const s = input.substance;
    const notesByAuthor = input.notes.map((n) => `- [${n.author}] ${n.note}`).join("\n") || "(no host notes yet)";
    const prompt = `${input.voice}${input.glossary}

Draft the SUBSTANCE segments for a podcast episode on ${s.company.legal_name} (${s.company.ticker ?? "unlisted"}). This show is
two hosts doing this together — weave BOTH hosts' notes into the discussion and ATTRIBUTE each host's take to them by name in
"contributions". Supply substance and a plain-language draft only: NO directorial instructions, no pacing/tone notes — those
belong to the hosts. Ground each point in the facts. Keep it to 3-5 TIGHT segments — concise substance, not a full transcript.

HOST NOTES:
${notesByAuthor}

SUBSTANCE:
- Thesis: ${s.thesis.one_liner} — ${s.thesis.long_form}
- Numbers: ${s.numbers.map((n) => `${n.label} ${n.unit === "USD/shares" ? n.value.toFixed(2) : n.value}`).join("; ") || "—"}
- Value/scenario: ${s.scenario ? `P(beat rev) ${s.scenario.beat_rev ?? "—"}; watch ${s.scenario.watch_items.join("; ")}` : "n/a"}
- Right/wrong: tensions ${s.thesis.tensions.join("; ") || "—"}; invalidation ${s.thesis.invalidation_triggers.join("; ") || "—"}
- Ground truth: ${s.sentiment ? `crowd ${s.sentiment.gap_direction} fundamentals (${s.sentiment.gap_magnitude})` : "no sentiment read"}

Return JSON: {"segments": [{"topic","point","facts":[".."],"sentiment_signal_context","contributions":[{"author","take"}]}]}`;
    return completeJSON({ prompt, schema: EpisodeDraft, model: "claude-sonnet-4-6", purpose: "content.podcast", maxTokens: 4500 });
  }
}

/** Build the episode script: deterministic metadata (authors + spoken disclosure) + facts appendix + the woven segments. */
export async function buildEpisode(substance: Substance, notes: EpisodeNote[], builder: EpisodeBuilder = new ClaudeEpisodeBuilder()): Promise<PodcastScript> {
  const draft = await builder.build({ substance, notes, voice: HOUSE_VOICE, glossary: await glossaryBlock() });
  const authors = [...new Set(notes.map((n) => n.author))];
  const spoken_disclosure = `A quick note before we start: this is ${EDUCATION_BADGE.toLowerCase()}. Everything we discuss is our own research for learning — not financial advice, and not a recommendation to buy or sell. ${positionsLine(substance.company.positions_held)}`;

  const b = (n: number) => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : `$${(n / 1e6).toFixed(0)}M`);
  const facts_appendix = substance.numbers.map((n, i) => ({
    figure: `${n.label}: ${n.unit === "USD/shares" ? n.value.toFixed(2) : b(n.value)}${n.yoy_pct != null ? ` (YoY ${(n.yoy_pct * 100).toFixed(1)}%)` : ""}`,
    source: substance.provenance[i % Math.max(1, substance.provenance.length)]?.origin ?? "SEC EDGAR",
  }));

  return {
    metadata: { companies: [`${substance.company.legal_name} (${substance.company.ticker ?? "unlisted"})`], cycle_label: substance.cycle_label, authors, spoken_disclosure },
    segments: draft.segments,
    facts_appendix,
  };
}
