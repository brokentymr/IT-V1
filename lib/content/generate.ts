/**
 * Content orchestration (Phase 8). Builds the "spider" from an APPROVED snapshot: the deck (visual
 * atom) → the newsletter (embeds deck slides) → the short-form pack (reductions). The podcast episode
 * is built separately from the studio's host notes. All builders are injectable so the pipeline is
 * deterministic in tests.
 */
import { assembleSubstance } from "./assemble";
import { disclosureFooter } from "./disclosure";
import { saveContentItem } from "./store";
import { listEpisodeNotes, markNotesUsed } from "./notes";
import { buildDeck, type Deck, type DeckBuilder } from "../engines/deck";
import { buildNewsletter, type Newsletter, type NewsletterBuilder } from "../engines/newsletter";
import { buildShortForm, type ShortFormPack, type ShortFormBuilder } from "../engines/shortform";
import { buildEpisode, type PodcastScript, type EpisodeBuilder } from "../engines/podcast";

export interface SpiderResult { deckId: string; newsletterId: string; shortformId: string; deck: Deck; newsletter: Newsletter; shortform: ShortFormPack }

export async function generateSpider(companyId: string, deps: { deck?: DeckBuilder; newsletter?: NewsletterBuilder; shortform?: ShortFormBuilder } = {}): Promise<SpiderResult> {
  const substance = await assembleSubstance(companyId); // throws NotApprovedError if the §8 checkpoint isn't cleared
  const disclosure = disclosureFooter(substance);
  const prov = substance.provenance;

  const t = substance.company.ticker ?? substance.company.legal_name;

  // Save each piece as it's built — a hiccup in a later format doesn't lose the earlier ones.
  const deck = await buildDeck(substance, deps.deck);
  const deckId = await saveContentItem({ companyId, snapshotId: substance.snapshot_id, type: "deck", title: deck.title, body: deck, provenance: prov, disclosure });

  const newsletter = await buildNewsletter(substance, deck, deps.newsletter);
  const newsletterId = await saveContentItem({ companyId, snapshotId: substance.snapshot_id, type: "newsletter", title: newsletter.title, body: newsletter, provenance: prov, disclosure });

  const shortform = await buildShortForm(substance, newsletter, deps.shortform);
  const shortformId = await saveContentItem({ companyId, snapshotId: substance.snapshot_id, type: "shortform", title: `${t} — short-form pack`, body: shortform, provenance: prov, disclosure });

  return { deckId, newsletterId, shortformId, deck, newsletter, shortform };
}

export interface EpisodeResult { id: string; script: PodcastScript }

export async function generateEpisode(companyId: string, deps: { episode?: EpisodeBuilder } = {}): Promise<EpisodeResult> {
  const substance = await assembleSubstance(companyId);
  const notes = await listEpisodeNotes(companyId);
  const script = await buildEpisode(substance, notes.map((n) => ({ author: n.author, note: n.note })), deps.episode);
  const id = await saveContentItem({
    companyId, snapshotId: substance.snapshot_id, type: "podcast",
    title: `${substance.company.ticker ?? substance.company.legal_name} — episode (${substance.cycle_label})`,
    body: script, provenance: substance.provenance, disclosure: disclosureFooter(substance),
  });
  await markNotesUsed(notes.map((n) => n.id), id);
  return { id, script };
}
