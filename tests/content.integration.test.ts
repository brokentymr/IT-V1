import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createEphemeralDb, type Ephemeral } from "./helpers/ephemeral-db";
import { setPool } from "../lib/db/pool";
import { assembleSubstance, NotApprovedError } from "../lib/content/assemble";
import { generateSpider, generateEpisode } from "../lib/content/generate";
import { getContentItem, listContent } from "../lib/content/store";
import { addEpisodeNote, listEpisodeNotes } from "../lib/content/notes";
import { deckHtml } from "../lib/content/render";
import type { DeckBuilder, DeckNarrative, Deck } from "../lib/engines/deck";
import type { NewsletterBuilder, NewsletterDraft } from "../lib/engines/newsletter";
import type { ShortFormBuilder, ShortFormPack } from "../lib/engines/shortform";
import type { EpisodeBuilder, EpisodeDraft } from "../lib/engines/podcast";

const MIDDLE = ["one_liner", "what_they_do", "numbers", "value_picture", "right", "wrong", "price", "ground_truth", "watching"];

const fakeDeck: DeckBuilder = {
  async build(): Promise<DeckNarrative> {
    return {
      slides: MIDDLE.map((section) => ({ section, title: `T:${section}`, headline: `H:${section}`, bullets: [`b:${section}`], metric: null, color: "neutral", visual: "list" })),
      glossary: [{ term: "moat", plain_definition: "a lasting advantage that keeps rivals out" }],
    };
  },
};
const fakeNewsletter: NewsletterBuilder = {
  async build(): Promise<NewsletterDraft> {
    return { title: "AAA — the value read", opening: "Welcome.", body: "The value picture.\n\n{{slide:value_picture}}", watching: "Margins.", embedded_slides: ["value_picture"], glossary: [] };
  },
};
const fakeShort: ShortFormBuilder = {
  async build(): Promise<ShortFormPack> {
    return { clips: [{ source_ref: "", hook: "Big hook", point_in_one_breath: "One breath.", visual_idea: "chart", platform: ["shorts"], suggested_caption: "cap", on_screen_text: "text", disclosure_caption: "" }] };
  },
};
const fakeEpisode: EpisodeBuilder = {
  async build({ notes }): Promise<EpisodeDraft> {
    return { segments: [{ topic: "Setup", point: "The setup.", facts: ["Revenue $85B"], sentiment_signal_context: "crowd ahead", contributions: notes.map((n) => ({ author: n.author, take: n.note })) }] };
  },
};

describe("Content layer (Phase 8)", () => {
  let db: Ephemeral;
  let companyId: string;

  async function seedApprovedCompany(): Promise<void> {
    const c = await db.pool.query<{ id: string }>(
      `INSERT INTO companies (legal_name, primary_ticker, identifiers, classification, coverage, coverage_status, gics_sector, listing)
       VALUES ('AAA Corp','AAA',$1,$2,$3,'monitoring','Information Technology','listed') RETURNING id`,
      [{ legal_name: "AAA Corp", tickers: ["AAA"] }, { gics_sector: "Information Technology" }, { status: "monitoring", positions_held: [] }],
    );
    companyId = c.rows[0].id;
    const cf = await db.pool.query<{ id: string }>(
      "INSERT INTO canonical_files (company_id, current_events) VALUES ($1,$2) RETURNING id",
      [companyId, JSON.stringify({ rolling_outlook: "Watch services growth", brand_sentiment: { sentiment_vs_fundamentals_gap: { direction: "sentiment_ahead", magnitude: "high" }, gap_rationale: "Crowd euphoric.", ground_momentum: "Retail bullish.", by_platform: [{ platform: "stocktwits", sentiment: 0.7, trend: "rising" }] } })],
    );
    const src = await db.pool.query<{ id: string }>(
      "INSERT INTO sources (company_id, tier, kind, origin, url, title, retrieved_at) VALUES ($1,1,'filing','SEC EDGAR','http://x','10-Q ACC',now()) RETURNING id", [companyId],
    );
    const content = {
      thesis: { one_liner: "Margin-led compounder", long_form: "Long form.", tensions: ["China demand"], invalidation_triggers: ["Net margin < 22% for two quarters"], conviction: 4 },
      fundamentals: { model: { line_items: { revenue: { label: "Revenue", value: 85e9, unit: "USD", yoy: { change_pct: 0.05 } }, net_income: { label: "Net income", value: 21e9, unit: "USD", yoy: null } } }, provenance: [{ claim_id: "fundamentals.revenue", source_ref: src.rows[0].id }] },
      scenario: { target_period: "2026-09-30", bands: { revenue: { p10: 74e9, p50: 108e9, p90: 120e9 }, eps: { p10: 1.2, p50: 1.5, p90: 1.9 } }, beat_probability: { revenue: 0.53 }, watch_items: ["Products revenue"], provenance: [{ claim_id: "scenario", source_ref: src.rows[0].id }] },
      hypotheses: { drivers: [{ name: "Services growth", direction: "tailwind", framing: "momentum" }] },
    };
    const snapId = randomUUID();
    await db.pool.query(
      "INSERT INTO canonical_snapshots (snapshot_id, canonical_file_id, company_id, as_of, cycle_label, trigger, conviction, content, diff) VALUES ($1,$2,$3,'2026-03-28','10-Q Q2 2026','manual',4,$4,'{}')",
      [snapId, cf.rows[0].id, companyId, JSON.stringify(content)],
    );
    // the §8 checkpoint
    await db.pool.query("INSERT INTO thesis_approvals (snapshot_id, company_id, note) VALUES ($1,$2,'looks good')", [snapId, companyId]);
  }

  beforeAll(async () => { db = await createEphemeralDb(); setPool(db.pool); });
  afterAll(async () => { setPool(undefined); await db.drop(); });

  it("refuses to assemble content before the §8 checkpoint, then succeeds once approved", async () => {
    const c = await db.pool.query<{ id: string }>(
      `INSERT INTO companies (legal_name, primary_ticker, identifiers, classification, coverage, coverage_status, gics_sector, listing)
       VALUES ('Unapproved','UNAP',$1,$2,$3,'monitoring','Information Technology','listed') RETURNING id`,
      [{ legal_name: "Unapproved", tickers: ["UNAP"] }, {}, { positions_held: [] }],
    );
    await expect(assembleSubstance(c.rows[0].id)).rejects.toBeInstanceOf(NotApprovedError);
    await seedApprovedCompany();
    const s = await assembleSubstance(companyId);
    expect(s.thesis.one_liner).toBe("Margin-led compounder");
    expect(s.provenance.length).toBe(1);
    expect(s.sentiment?.gap_direction).toBe("sentiment_ahead");
  });

  it("generates the spider: deck (header→sections→footer) + newsletter + short-form, all sourced & disclosed", async () => {
    const r = await generateSpider(companyId, { deck: fakeDeck, newsletter: fakeNewsletter, shortform: fakeShort });

    const deck = (await getContentItem(r.deckId))!;
    const body = deck.body as Deck;
    expect(body.slides[0].section).toBe("header");
    expect(body.slides[body.slides.length - 1].section).toBe("footer");
    expect(body.slides.slice(1, -1).map((s) => s.section)).toEqual(MIDDLE); // §6.2 order preserved
    expect(body.slides[0].bullets.some((b) => b.includes("Education, not advice"))).toBe(true);
    expect(deck.disclosure).toContain("Education, not advice");
    expect((deck.provenance as unknown[]).length).toBe(1);

    // newsletter embeds a deck slide + carries disclosure + sources
    const nl = (await getContentItem(r.newsletterId))!.body as { markdown: string; embedded_slides: string[] };
    expect(nl.embedded_slides).toContain("value_picture");
    expect(nl.markdown).toContain("{{slide:value_picture}}");
    expect(nl.markdown).toContain("Education, not advice");
    expect(nl.markdown).toContain("## Sources");

    // short-form clip always carries a disclosure caption (defaulted from empty)
    const sf = (await getContentItem(r.shortformId))!.body as ShortFormPack;
    expect(sf.clips[0].disclosure_caption.length).toBeGreaterThan(0);

    // glossary recorded by the plain-language layer
    const gl = await db.pool.query("SELECT plain_definition FROM content_glossary WHERE term='moat'");
    expect(gl.rowCount).toBe(1);

    // deck renders to printable HTML
    const html = deckHtml(body);
    expect(html).toContain("<section class=\"slide\"");
    expect(html).toContain("AAA Corp");
  });

  it("builds a podcast episode from BOTH hosts' notes, attributed, and marks the notes used", async () => {
    await addEpisodeNote(companyId, "Tim", "I want to open on the euphoria gap.");
    await addEpisodeNote(companyId, "Partner", "Let's be honest about the China risk.");

    const { id, script } = await generateEpisode(companyId, { episode: fakeEpisode });
    expect(script.metadata.authors.sort()).toEqual(["Partner", "Tim"]);
    expect(script.metadata.spoken_disclosure).toContain("Education, not advice".toLowerCase());
    const authorsInSegments = script.segments[0].contributions.map((c) => c.author).sort();
    expect(authorsInSegments).toEqual(["Partner", "Tim"]);
    expect(script.facts_appendix.length).toBeGreaterThan(0);

    // notes marked used
    const remaining = await listEpisodeNotes(companyId, { unusedOnly: true });
    expect(remaining.length).toBe(0);
    const saved = await getContentItem(id);
    expect(saved?.type).toBe("podcast");

    // everything shows in the library
    const lib = await listContent(companyId);
    expect(lib.map((x) => x.type).sort()).toEqual(["deck", "newsletter", "podcast", "shortform"]);
  });
});
