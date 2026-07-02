/**
 * Engine 7 — Short-form pack (spec §6.5, owner's "reductions" ring). Clips are extractions FROM the
 * long-form newsletter (the spider), not generated fresh — each a one-breath idea with a hook, a visual
 * idea, and its own disclosure caption. Format is the normative §6.5 clip shape.
 */
import { z } from "zod";
import { completeJSON } from "../llm/client";
import type { Substance } from "../content/assemble";
import type { Newsletter } from "./newsletter";
import { HOUSE_VOICE } from "../content/plain_language";

export const Clip = z.object({
  source_ref: z.string().default(""),
  hook: z.string(),
  point_in_one_breath: z.string(),
  visual_idea: z.string(),
  platform: z.array(z.enum(["shorts", "reels", "tiktok"])).default(["shorts", "reels", "tiktok"]),
  suggested_caption: z.string(),
  on_screen_text: z.string(),
  disclosure_caption: z.string().default(""),
});
export type Clip = z.infer<typeof Clip>;

export const ShortFormPack = z.object({ clips: z.array(Clip).default([]) });
export type ShortFormPack = z.infer<typeof ShortFormPack>;

export interface ShortFormBuilder { build(input: { substance: Substance; newsletterMarkdown: string; voice: string; registryBlock?: string }): Promise<ShortFormPack> }

const DEFAULT_DISCLOSURE = "Education, not advice.";

export class ClaudeShortFormBuilder implements ShortFormBuilder {
  async build(input: { substance: Substance; newsletterMarkdown: string; voice: string; registryBlock?: string }): Promise<ShortFormPack> {
    const prompt = `${input.voice}${input.registryBlock ? `\n${input.registryBlock}` : ""}

REDUCE the newsletter below into 3-5 short-form clip candidates for ${input.substance.company.legal_name}
(${input.substance.company.ticker ?? "unlisted"}). Each clip is ONE idea a viewer gets in a single breath — a strong hook,
the point, a concrete visual idea, and platform-ready captions. Pull the ideas FROM the newsletter; do not invent new claims.

NEWSLETTER:
${input.newsletterMarkdown.slice(0, 6000)}

Return JSON: {"clips": [{"hook","point_in_one_breath","visual_idea","platform":["shorts|reels|tiktok"],"suggested_caption","on_screen_text","disclosure_caption"}]}`;
    return completeJSON({ prompt, schema: ShortFormPack, model: "claude-sonnet-4-6", purpose: "content.shortform", maxTokens: 1600 });
  }
}

/** Build the pack; ensure every clip carries a disclosure caption (never omitted). */
export async function buildShortForm(substance: Substance, newsletter: Newsletter, builder: ShortFormBuilder = new ClaudeShortFormBuilder(), registryBlock?: string): Promise<ShortFormPack> {
  const pack = await builder.build({ substance, newsletterMarkdown: newsletter.markdown, voice: HOUSE_VOICE, registryBlock });
  return { clips: pack.clips.map((c) => ({ ...c, disclosure_caption: c.disclosure_caption?.trim() || DEFAULT_DISCLOSURE })) };
}
