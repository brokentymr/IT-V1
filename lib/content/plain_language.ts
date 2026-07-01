/**
 * The plain-language layer (spec §5). Sits in front of Engines 5 & 7: it carries the HOUSE VOICE and a
 * running glossary so the rigorous knowledge base comes out welcoming and consistent. Realized as a
 * shared prompt layer (voice + glossary injected into every audience generator, new terms recorded
 * back) rather than a costly second rewrite pass. Internal consumables keep full technical precision.
 */
import { query } from "../db/pool";

/** House voice (owner direction 2026-06-30). Plain BUT substantive — define, don't dumb down. */
export const HOUSE_VOICE = `VOICE — write for an everyday investor, a curious newcomer; family-friendly and welcoming.
- Warm, healthy, approachable. Calm and clear, never breathless or hypey.
- Focused on VALUE: what the business is worth and why, not the ticker's mood.
- Cut through the hype to distill the truth as best we can identify it — say plainly what we do and don't know.
- Risk-management FIRST: be honest about what could go wrong — but willing to lean in when the opportunity is genuinely there.
- Plain BUT substantive: when a concept matters, DEFINE it in everyday words rather than dropping it. Never dumb down the nuance.
- No unexplained jargon. No advice framing (no "buy/sell/hold") — this is EDUCATION, not advice. Use concrete, everyday analogies.`;

export interface GlossaryEntry { term: string; plain_definition: string }

/** Current running glossary, formatted for prompt injection (empty string if none yet). */
export async function glossaryBlock(): Promise<string> {
  const { rows } = await query<GlossaryEntry>("SELECT term, plain_definition FROM content_glossary ORDER BY term");
  if (!rows.length) return "";
  return `\n\nRUNNING GLOSSARY (reuse these plain definitions for consistency):\n${rows.map((g) => `- ${g.term}: ${g.plain_definition}`).join("\n")}`;
}

/** Record any new terms a generator defined, so the voice stays consistent across consumables. */
export async function recordGlossary(entries: GlossaryEntry[]): Promise<void> {
  for (const e of entries) {
    if (!e.term?.trim() || !e.plain_definition?.trim()) continue;
    await query(
      "INSERT INTO content_glossary (term, plain_definition) VALUES ($1,$2) ON CONFLICT (term) DO NOTHING",
      [e.term.trim(), e.plain_definition.trim()],
    );
  }
}
