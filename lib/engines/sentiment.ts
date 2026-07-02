/**
 * Engine 4 — Brand / Sentiment (spec §4.4). Runs on a weekly full cycle AND on event-escalation from
 * Engine 3 (the SENTIMENT_RUN job, a window after a major event). Per platform it computes the
 * deterministic aggregates (volume, net sentiment, trend); the analyzer narrates ground-momentum,
 * extracts themes, and reasons the sentiment-vs-fundamentals gap. Degrades gracefully — a missing
 * platform lowers confidence and is flagged, never fails. A material gap opens a sentiment_gap area
 * of interest (owner decision 2026-06-30), tying the crowd-vs-fundamentals divergence into the desk.
 */
import { query } from "../db/pool";
import type { ProvenanceStamp } from "../sources/types";
import { StockTwitsAdapter, GdeltToneAdapter, type StockTwitsMessage } from "../sources/sentiment";
import { SENTIMENT_CONFIG, type SentimentConfig } from "../config/sentiment";
import { ENTITY_GATE } from "../config/entity_gate";
import { ClaudeSentimentAnalyzer, type SentimentAnalyzer } from "./sentiment_analyzer";
import { applyVolumeFloor, shouldSuppressTempo, scrubTempo } from "./sentiment_floor";
import { accumulateArea } from "./areas_of_interest";

export interface PlatformSignal { platform: string; volume: number; sentiment: number; trend: string; top_themes: string[]; samples: string[] }

export interface SentimentResult {
  company_id: string;
  ticker: string;
  trigger: string;
  window_days: number;
  by_platform: Array<{ platform: string; volume: number; sentiment: number; trend: string; top_themes: string[]; net_display: string; low_volume: boolean }>;
  ground_momentum: string;
  gap: { direction: string; magnitude: string; rationale: string };
  confidence: number;
  degraded: string[];
  area_opened: boolean;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Net sentiment of a time-ordered list, split into older/newer halves → trend. */
function trendOf(items: Array<{ t: number; s: number }>): string {
  if (items.length < 4) return "flat";
  const sorted = [...items].sort((a, b) => a.t - b.t);
  const mid = Math.floor(sorted.length / 2);
  const net = (xs: typeof sorted) => (xs.length ? xs.reduce((a, b) => a + b.s, 0) / xs.length : 0);
  const d = net(sorted.slice(mid)) - net(sorted.slice(0, mid));
  return d > 0.1 ? "rising" : d < -0.1 ? "falling" : "flat";
}

function aggregateStockTwits(msgs: StockTwitsMessage[], cutoff: number, maxSamples: number): { volume: number; sentiment: number; trend: string; samples: string[] } {
  const inWindow = msgs.filter((m) => { const t = Date.parse(m.created_at); return Number.isFinite(t) && t >= cutoff; });
  const tagged = inWindow.filter((m) => m.sentiment);
  const bull = tagged.filter((m) => m.sentiment === "Bullish").length;
  const bear = tagged.filter((m) => m.sentiment === "Bearish").length;
  const sentiment = bull + bear ? (bull - bear) / (bull + bear) : 0;
  const series = inWindow.map((m) => ({ t: Date.parse(m.created_at), s: m.sentiment === "Bullish" ? 1 : m.sentiment === "Bearish" ? -1 : 0 }));
  return { volume: inWindow.length, sentiment, trend: trendOf(series), samples: inWindow.slice(0, maxSamples).map((m) => m.body) };
}

const effectScore = (e: string): number => (e === "supports" ? 1 : e === "pressures" || e === "invalidates" ? -1 : 0);

export async function runSentiment(opts: {
  companyId: string;
  trigger?: "cadence" | "escalation";
  windowDays?: number;
  config?: SentimentConfig;
  stocktwits?: StockTwitsAdapter;
  gdelt?: GdeltToneAdapter;
  analyzer?: SentimentAnalyzer;
  now?: number;
}): Promise<SentimentResult> {
  const config = opts.config ?? SENTIMENT_CONFIG;
  const windowDays = opts.windowDays ?? config.windowDays;
  const trigger = opts.trigger ?? "cadence";
  const now = opts.now ?? Date.now();
  const cutoff = now - windowDays * 86_400_000;

  const c = await query<{ id: string; legal_name: string; primary_ticker: string }>(
    "SELECT id, legal_name, primary_ticker FROM companies WHERE id = $1", [opts.companyId],
  );
  const company = c.rows[0];
  if (!company) throw new Error(`company ${opts.companyId} not found`);

  // Standing fundamentals (the gap's anchor).
  const snap = await query<{ thesis: { one_liner?: string; conviction?: number } | null }>(
    "SELECT content->'thesis' AS thesis FROM canonical_snapshots WHERE company_id = $1 ORDER BY as_of DESC, created_at DESC LIMIT 1",
    [opts.companyId],
  );
  const thesis = snap.rows[0]?.thesis ?? null;

  const signals: PlatformSignal[] = [];
  const degraded: string[] = [];
  const provenance: ProvenanceStamp[] = [];

  // --- StockTwits (retail) ---
  if (config.platforms.includes("stocktwits") && company.primary_ticker) {
    const res = await (opts.stocktwits ?? new StockTwitsAdapter()).streamSymbol(company.primary_ticker);
    if (res.ok && res.data) {
      const a = aggregateStockTwits(res.data, cutoff, config.maxSampleItems);
      signals.push({ platform: "stocktwits", top_themes: [], ...a });
      if (res.provenance) provenance.push(res.provenance);
    } else degraded.push(...(res.missing.length ? res.missing : ["stocktwits unavailable"]));
  }

  // --- GDELT (media tone) ---
  if (config.platforms.includes("gdelt")) {
    const res = await (opts.gdelt ?? new GdeltToneAdapter()).tone(company.legal_name);
    if (res.ok && res.data) {
      signals.push({ platform: "gdelt", volume: res.data.volume, sentiment: clamp(res.data.avg_tone / 10, -1, 1), trend: "flat", top_themes: [], samples: [] });
      if (res.provenance) provenance.push(res.provenance);
    } else degraded.push(...(res.missing.length ? res.missing : ["gdelt unavailable"]));
  }

  // --- News-derived (our own Engine-3 notes; always available) ---
  let newsNet = 0;
  if (config.platforms.includes("news")) {
    const notes = await query<{ effect: string; headline: string; t: string }>(
      `SELECT content->'impact_analysis'->>'thesis_effect' AS effect, content->>'headline' AS headline,
              to_char(detected_at,'YYYY-MM-DD"T"HH24:MI:SS') AS t
         FROM news_notes
        WHERE company_id = $1 AND origin_kind = 'primary' AND detected_at >= to_timestamp($2 / 1000.0)
          AND NOT (category = 'other' AND importance_score < $3)
        ORDER BY detected_at DESC LIMIT 50`,
      [opts.companyId, cutoff, ENTITY_GATE.otherCategoryImportanceFloor],
    );
    if (notes.rows.length) {
      const scored = notes.rows.map((n) => ({ t: Date.parse(n.t), s: effectScore(n.effect ?? "neutral") }));
      newsNet = scored.reduce((a, b) => a + b.s, 0) / scored.length;
      signals.push({ platform: "news", volume: notes.rows.length, sentiment: newsNet, trend: trendOf(scored), top_themes: [], samples: notes.rows.slice(0, config.maxSampleItems).map((n) => n.headline) });
    } else degraded.push("news: no notes in window");
  }

  const recentDirection = `${thesis?.conviction ? `thesis conviction ${thesis.conviction}/5` : "no thesis"}; recent news ${newsNet > 0.15 ? "supportive" : newsNet < -0.15 ? "pressuring" : "mixed"}`;

  // Statistical floor (control P7): when EVERY contributing platform is below the volume floor the whole
  // window is too thin to claim tempo — instruct the analyzer to describe the crowd statically, then
  // scrub any velocity language it emits anyway. shouldSuppressTempo over an empty list is vacuously true.
  const suppressTempo = signals.length > 0 && shouldSuppressTempo(signals, config);

  // Synthesis (themes + ground-momentum + gap). Skip the LLM if every platform degraded.
  let ground_momentum = "Insufficient signal — all platforms degraded.";
  let gap = { direction: "aligned", magnitude: "low" as "low" | "medium" | "high", rationale: "No usable sentiment signal this window." };
  if (signals.length) {
    const synth = await (opts.analyzer ?? new ClaudeSentimentAnalyzer()).synthesize({
      company: { legal_name: company.legal_name, ticker: company.primary_ticker },
      platforms: signals.map((s) => ({ platform: s.platform, volume: s.volume, sentiment: s.sentiment, trend: s.trend, samples: s.samples })),
      fundamentals: { thesis: thesis?.one_liner ?? null, conviction: thesis?.conviction ?? null, recent_direction: recentDirection },
      ...(suppressTempo ? { suppress_tempo: true, bannedPhrases: config.tempoBannedPhrases } : {}),
    });
    // Post-filter the narrative: the analyzer is a fallible collaborator, so we deterministically strip
    // any tempo/velocity language it emitted anyway when the window is too thin to support it.
    ground_momentum = suppressTempo ? scrubTempo(synth.ground_momentum, config) : synth.ground_momentum;
    gap = suppressTempo ? { ...synth.gap, rationale: scrubTempo(synth.gap.rationale, config) } : synth.gap;
    for (const s of signals) s.top_themes = synth.by_platform_themes.find((t) => t.platform === s.platform)?.top_themes ?? [];
  }

  const confidence = Number(clamp(1 - config.confidencePenaltyPerMissing * degraded.length, 0, 1).toFixed(2));
  // Volume floor per platform: below the floor the trend/net display is suppressed (numeric kept for
  // back-compat); between the floors the net is capped to one decimal; above, full precision stands.
  const by_platform = signals.map((s) => {
    const f = applyVolumeFloor({ platform: s.platform, volume: s.volume, sentiment: s.sentiment, trend: s.trend, top_themes: s.top_themes }, config);
    return { platform: f.platform, volume: f.volume, sentiment: f.sentiment, trend: f.trend, top_themes: f.top_themes, net_display: f.net_display, low_volume: f.low_volume };
  });

  const block = {
    as_of: new Date(now).toISOString(),
    trigger, window_days: windowDays,
    by_platform,
    ground_momentum,
    sentiment_vs_fundamentals_gap: { direction: gap.direction, magnitude: gap.magnitude },
    gap_rationale: gap.rationale,
    confidence, degraded,
    provenance,
  };
  await query("INSERT INTO canonical_files (company_id) VALUES ($1) ON CONFLICT (company_id) DO NOTHING", [opts.companyId]);
  await query(
    "UPDATE canonical_files SET current_events = jsonb_set(COALESCE(current_events,'{}'), '{brand_sentiment}', $2::jsonb) WHERE company_id = $1",
    [opts.companyId, JSON.stringify(block)],
  );

  // A material crowd-vs-fundamentals divergence is itself a salience signal (owner decision).
  let area_opened = false;
  if (config.gapAoiMagnitudes.includes(gap.magnitude) && gap.direction !== "aligned") {
    const arrow = gap.direction === "sentiment_ahead" ? "ahead of" : "behind";
    const area = await accumulateArea({
      companyId: opts.companyId, category: "sentiment_gap", band: gap.magnitude === "high" ? "major" : "material",
      score: gap.magnitude === "high" ? 70 : 50, headline: `Sentiment ${arrow} fundamentals (${gap.magnitude})`,
      url: null, summary: gap.rationale,
    }).catch((e) => { console.warn(`[sentiment] gap area failed: ${(e as Error).message}`); return null; });
    area_opened = !!area?.created;
  }

  return {
    company_id: opts.companyId, ticker: company.primary_ticker, trigger, window_days: windowDays,
    by_platform, ground_momentum, gap, confidence, degraded, area_opened,
  };
}
