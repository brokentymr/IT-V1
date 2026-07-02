/**
 * The §3 data-model contract (ARCHITECTURE.md). These zod schemas are the runtime
 * enforcement of "agents and the application read and write to these shapes exactly".
 * Inferred TS types are exported alongside each schema.
 *
 * NOTE on fidelity: the Phase-1-critical entities (Source, Market, Company, CompanyLink,
 * CanonicalFile skeleton, NewsNote) are modeled precisely. The deep snapshot sub-blocks
 * (fundamentals / brand_sentiment / signals / thesis) are written by Engines 2–4 and are
 * modeled structurally here; they are tightened in those engines' phases. No normative
 * field is renamed/reordered (per the spec change rule).
 */
import { z } from "zod";

// ---------- primitives ----------
const Uuid = z.string().uuid();
const IdRef = z.string(); // spec uses a loose `id` for some refs
const IsoDate = z.string(); // YYYY-MM-DD
const IsoTimestamp = z.string(); // ISO 8601
const OpenMap = z.record(z.string(), z.unknown());

// ---------- enums (§3) ----------
export const Region = z.enum(["NA", "EMEA", "APAC", "LATAM"]);
export const FilingSystem = z.enum(["SEC_EDGAR", "UK_NSM", "EDINET", "OTHER"]);
export const CoverageStatus = z.enum([
  "watchlist", "queued", "in_research", "in_review", "published", "monitoring",
]);
export const PositionDirection = z.enum(["long", "short"]);
export const SnapshotTrigger = z.enum(["filing", "manual"]);
export const NewsCategory = z.enum([
  "guidance", "product", "management", "legal_regulatory",
  "macro", "m_and_a", "capital_markets", "other",
]);
export const NoteOriginKind = z.enum(["primary", "read_through"]);
export const ThesisEffect = z.enum(["supports", "pressures", "neutral", "invalidates"]);
export const Magnitude = z.enum(["low", "medium", "high"]);
export const NoteStatus = z.enum(["logged", "flagged", "escalated"]);
export const LinkType = z.enum([
  "competitor", "supplier", "customer", "parent", "subsidiary",
  "jv_partner", "shared_end_market", "thematic_peer", "macro_correlated",
]);
export const LinkStrength = z.enum(["weak", "medium", "strong"]);
export const LinkStatus = z.enum(["active", "stale", "unverified"]);
export const RawDocumentKind = z.enum(["filing", "transcript", "research", "news", "other"]);
export const SignalKind = z.enum(["price", "tradingview_alert"]);
export const SourceKind = z.enum([
  "filing", "transcript", "research", "news", "pricing", "tradingview_alert", "api", "web", "other",
]);

// ---------- provenance (§8) ----------
export const ProvenanceRef = z.object({ claim_id: z.string(), source_ref: IdRef });
export type ProvenanceRef = z.infer<typeof ProvenanceRef>;

// A single located numeric claim (control P3). Every material figure is a claim with a locator; a
// free-text number with no matching verified claim is quarantined (never auto-published).
export const NumericClaim = z.object({
  value: z.number(),
  unit: z.string().nullable(),
  period: z.string().nullable(),
  source_doc: z.string().nullable(),
  source_locator: z.string().nullable(),
  extraction_confidence: z.number().default(0),
  verified: z.boolean().default(false),
});
export type NumericClaim = z.infer<typeof NumericClaim>;

// ---------- claim dependency DAG (control P4) ----------
// A FACT is a number/observation pulled from a source; a CLAIM is a narrative statement that consumes
// one or more facts. When a fact is corrected/retracted every claim that consumes it goes STALE; a hard
// accounting-identity failure retracts the implicated fact. Status lives in the mutable claim_dag tables
// (migration 0020), kept separate from the append-only snapshot content.
export const ClaimStatus = z.enum(["fresh", "stale", "retracted"]);
export type ClaimStatus = z.infer<typeof ClaimStatus>;
export const FactStatus = z.enum(["active", "corrected", "retracted"]);
export type FactStatus = z.infer<typeof FactStatus>;

export const FactNode = z.object({
  fact_key: z.string(),
  kind: z.string(),
  source_ref: IdRef.nullable().default(null),
  value_num: z.number().nullable().default(null),
  value_text: z.string().nullable().default(null),
  period: z.string().nullable().default(null),
  status: FactStatus.default("active"),
});
export type FactNode = z.infer<typeof FactNode>;

export const ClaimNode = z.object({
  claim_kind: z.string(),
  ordinal: z.number().int().default(0),
  text: z.string(),
  status: ClaimStatus.default("fresh"),
  fact_keys: z.array(z.string()).default([]),
});
export type ClaimNode = z.infer<typeof ClaimNode>;

/** A Tier-1 source row (the `sources` table). Every material claim refs one. */
export const Source = z.object({
  id: Uuid,
  company_id: Uuid.nullable().optional(),
  tier: z.number().int().min(1).default(1),
  kind: SourceKind,
  origin: z.string(),            // e.g. "SEC EDGAR"
  url: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  retrieved_at: IsoTimestamp,
  blob_ref: z.string().nullable().optional(), // object-storage key if archived
  metadata: OpenMap.default({}),
});
export type Source = z.infer<typeof Source>;

// ---------- §3.2 market ----------
export const Market = z.object({
  exchange: z.string(),
  country: z.string(),
  region: Region,
  currency: z.string(),
  calendar_ref: IdRef.nullable().optional(),
  primary_filing_system: FilingSystem,
});
export type Market = z.infer<typeof Market>;

// ---------- shared: position ----------
export const Position = z.object({
  instrument: z.string(),
  direction: PositionDirection,
  size: z.number(),
  as_of: IsoDate,
});
export type Position = z.infer<typeof Position>;

// ---------- §3.1 classification (GICS path) ----------
// Best-effort under SEC/SIC classification (Phase 1 decision): gics_sector is set for any
// recognized SIC; deeper levels (and the sector itself, for unclassifiable SICs) may be null,
// with a low classification_confidence recorded on the company and the note flagged for review.
export const Classification = z.object({
  gics_sector: z.string().nullable(),
  industry_group: z.string().nullable(),
  industry: z.string().nullable(),
  sub_industry: z.string().nullable(),
});
export type Classification = z.infer<typeof Classification>;

// ---------- §3.3 company index record ----------
export const CompanyIdentifiers = z.object({
  legal_name: z.string(),
  tickers: z.array(z.string()),
  isin: z.string().nullable().optional(),
  cik: z.string().nullable().optional(),
  lei: z.string().nullable().optional(),
});
export type CompanyIdentifiers = z.infer<typeof CompanyIdentifiers>;

export const Coverage = z.object({
  status: CoverageStatus,
  authors: z.array(z.string()).default([]),
  next_earnings_date: IsoDate.nullable().optional(),          // current best estimate (auto-resolved)
  next_earnings_date_override: IsoDate.nullable().optional(), // explicit owner override; wins if set
  positions_held: z.array(Position).default([]),
});
export type Coverage = z.infer<typeof Coverage>;

export const Company = z.object({
  id: Uuid,
  identifiers: CompanyIdentifiers,
  classification: Classification,
  markets: z.array(Market),
  tradingview_symbol: z.string().nullable().optional(),
  coverage: Coverage,
  canonical_file_ref: Uuid.nullable().optional(),
  content_refs: z.array(Uuid).default([]),
});
export type Company = z.infer<typeof Company>;

// ---------- §3.8 company relationship (link) ----------
export const CompanyLink = z.object({
  id: Uuid,
  from_company_id: Uuid,
  to_company_id: Uuid,
  type: LinkType,
  cross_sector: z.boolean(),
  strength: LinkStrength,
  direction_note: z.string().nullable().optional(),
  rationale: z.string().nullable().optional(),
  source_ref: IdRef.nullable().optional(),
  status: LinkStatus,
});
export type CompanyLink = z.infer<typeof CompanyLink>;

// ---------- §3.6 news note ----------
export const ReadThroughEntry = z.object({
  affected_company_id: Uuid,
  link_type: LinkType,
  expected_effect: z.string(),
  materiality: z.string(),
});

export const NewsNote = z.object({
  id: Uuid,
  company_id: Uuid,
  detected_at: IsoTimestamp,
  source_ref: IdRef,
  headline: z.string(),
  summary: z.string(),
  category: NewsCategory,
  origin: z.object({
    kind: NoteOriginKind,
    origin_event_ref: IdRef.nullable(),
    origin_company_id: Uuid.nullable(),
    link_type: LinkType.nullable(),
  }),
  importance_score: z.number().int().min(0).max(100),
  importance_rationale: z.string(),
  impact_analysis: z.object({
    forward_outlook: z.string(),
    thesis_effect: ThesisEffect,
    invalidation_trigger_hit: z.string().nullable(),
    sentiment_effect: z.string(),
    estimated_magnitude: Magnitude,
  }),
  read_through: z.array(ReadThroughEntry).default([]),
  status: NoteStatus,
  escalation: z
    .object({
      triggered: z.boolean(),
      type: z.string().default("sentiment_run"),
      window_days: z.number().int(),
      job_ref: IdRef.nullable(),
    })
    .nullable()
    .optional(),
  carried_into: Uuid.nullable().optional(),
});
export type NewsNote = z.infer<typeof NewsNote>;

// ---------- §3.7 raw document & signal event ----------
export const RawDocument = z.object({
  id: Uuid,
  company_id: Uuid,
  kind: RawDocumentKind,
  received_at: IsoTimestamp,
  source: z.string(),
  blob_ref: z.string(), // object-storage key
  metadata: OpenMap.default({}),
});
export type RawDocument = z.infer<typeof RawDocument>;

export const SignalEvent = z.object({
  id: Uuid,
  company_id: Uuid,
  ts: IsoTimestamp,
  kind: SignalKind,
  payload: OpenMap,
});
export type SignalEvent = z.infer<typeof SignalEvent>;

// ---------- §3.4 canonical file snapshot sub-blocks ----------
// Modeled structurally; refined by Engines 2–4 in their phases.
export const Fundamentals = z.object({
  statements: OpenMap.optional(),
  capital_structure: OpenMap.optional(),
  model: OpenMap.optional(),
  provenance: z.array(ProvenanceRef).default([]),
});

// ---------- basis labeling (control P11 — GAAP / non-GAAP / adjusted) ----------
// Every reported figure carries its reporting basis so a non-GAAP number can never be silently read
// as GAAP. Derived-in-house figures (e.g. FCF) carry the company-definition adjusted label; a
// GAAP vs non-GAAP divergence beyond tolerance is surfaced as a reconciliation row; and any figure
// asserted in the narrative that differs from the labeled GAAP model value with no basis word is flagged.
export const BasisLabel = z.enum(["gaap", "non_gaap", "adjusted", "unadjusted"]);
export type BasisLabel = z.infer<typeof BasisLabel>;

export const FcfBridge = z.object({ ocf: z.number(), capex: z.number(), fcf: z.number() });
export type FcfBridge = z.infer<typeof FcfBridge>;

export const BasisReconciliationItem = z.object({
  metric: z.string(),
  gaap_value: z.number(),
  non_gaap_value: z.number(),
  delta: z.number(),
  gaap_label: z.string(),
  non_gaap_label: z.string(),
});
export type BasisReconciliationItem = z.infer<typeof BasisReconciliationItem>;

export const BasisBlock = z.object({
  line_item_basis: z.record(z.string(), BasisLabel).default({}),
  fcf_bridge: FcfBridge.nullable().default(null),
  reconciliations: z.array(BasisReconciliationItem).default([]),
  unlabeled_flags: z.array(z.string()).default([]),
  provenance: z.array(ProvenanceRef).default([]),
});
export type BasisBlock = z.infer<typeof BasisBlock>;

export const BrandSentiment = z.object({
  by_platform: z.array(OpenMap).default([]),
  ground_momentum: z.string().nullable().optional(),
  sentiment_vs_fundamentals_gap: OpenMap.optional(),
  coverage_window: OpenMap.optional(),
  provenance: z.array(ProvenanceRef).default([]),
});

export const Signals = z.object({
  pricing: OpenMap.optional(),
  tradingview_alerts: z.array(OpenMap).default([]),
  technical_context: z.string().nullable().optional(),
});

// ---------- risks & triggers as one typed, joined system (control P10) ----------
// A thesis now carries typed risks and typed invalidation triggers that are JOINED: each risk names the
// mechanism + severity and may point at the trigger that would confirm it; each trigger carries the exact
// disclosure/observation that would fire it plus a source ref. The legacy string[] invalidation_triggers
// is KEPT untouched for backward compatibility. The risk<->trigger join is checked (lib/engines/risk_join).
export const RiskSeverity = z.enum(["low", "medium", "high"]);
export type RiskSeverity = z.infer<typeof RiskSeverity>;

export const Risk = z.object({
  id: z.string(),
  title: z.string(),
  mechanism: z.string(),
  quantified_impact: z.string().nullable().default(null),
  severity: RiskSeverity,
  linked_trigger_id: z.string().nullable().default(null),
});
export type Risk = z.infer<typeof Risk>;

export const InvalidationTrigger = z.object({
  id: z.string(),
  condition: z.string(),
  disclosure: z.string(),
  source_ref: IdRef.nullable().default(null),
});
export type InvalidationTrigger = z.infer<typeof InvalidationTrigger>;

export const Thesis = z.object({
  one_liner: z.string(),
  long_form: z.string(),
  tensions: z.array(z.string()).default([]),
  catalysts: z
    .array(z.object({ event: z.string(), date: IsoDate.nullable(), expected_impact: z.string() }))
    .default([]),
  invalidation_triggers: z.array(z.string()).default([]),
  risks: z.array(Risk).default([]),
  triggers: z.array(InvalidationTrigger).default([]),
  conviction: z.number().int().min(1).max(5),
  positions_held: z.array(Position).default([]),
});

// External factual context (Perplexity / Fiscal.ai): consensus + analyst view. ADVISORY — never
// the modeled-number source of truth (that is `fundamentals`, computed from XBRL); provenance-stamped.
export const MarketContext = z.object({
  consensus: OpenMap.nullable().optional(),
  analyst_view: OpenMap.nullable().optional(),
  provenance: z.array(ProvenanceRef).default([]),
});
export type MarketContext = z.infer<typeof MarketContext>;

// §4.2 extended hypothesis (Phase-4 improvement #3): drivers read from the filing's MD&A, each with
// a bear/base/bull impact on a tracked metric. Grounded (quote + filing ref); feeds the Monte Carlo.
export const MetricKey = z.enum(["revenue", "gross_margin", "operating_margin", "net_margin", "net_income", "eps"]);
export type MetricKey = z.infer<typeof MetricKey>;

export const Driver = z.object({
  name: z.string(),
  metric: MetricKey,
  direction: z.enum(["tailwind", "headwind", "mixed"]),
  framing: z.string(),
  quote: z.string().nullable().optional(),
  // bear/base/bull impact: percentage points on revenue growth, or on the margin level
  impact_pct: z.object({ bear: z.number(), base: z.number(), bull: z.number() }),
});
export type Driver = z.infer<typeof Driver>;

export const Hypotheses = z.object({
  as_of: IsoTimestamp,
  filing_ref: IdRef.nullable().optional(),
  drivers: z.array(Driver).default([]),
  provenance: z.array(ProvenanceRef).default([]),
});
export type Hypotheses = z.infer<typeof Hypotheses>;

// Monte Carlo scenario (Phase-4 improvement #4): the distribution of next-period outcomes.
const ScenarioBand = z.object({ p10: z.number(), p50: z.number(), p90: z.number() });

// control P6: a typed "what to watch" item. Each item names the driver, the metric it moves, and the
// OUTPUT band it flows into (a margin driver moves net_margin — NEVER revenue), with the bear/bull
// impact in points and the P10/P90 band values (invariant: bear_value=P10, bull_value=P90). `text` is
// the rendered plain-language string so every existing string consumer stays untouched.
export const WatchItem = z.object({
  driver: z.string(),
  metric: MetricKey,
  affected_band: z.enum(["revenue", "net_margin", "net_income", "eps"]),
  bear_pts: z.number(),
  bull_pts: z.number(),
  bear_value: z.number(),
  bull_value: z.number(),
  contribution: z.number(),
  text: z.string(),
});
export type WatchItem = z.infer<typeof WatchItem>;

export const Scenario = z.object({
  target_period: z.string().nullable(),
  base_period: z.string().nullable(),
  runs: z.number().int(),
  bands: z.object({
    revenue: ScenarioBand.optional(),
    net_income: ScenarioBand.optional(),
    eps: ScenarioBand.optional(),
    revenue_growth: ScenarioBand.optional(),
    net_margin: ScenarioBand.optional(),
  }),
  beat_probability: z.object({ revenue: z.number().nullable(), eps: z.number().nullable() }),
  anchor: OpenMap.nullable().optional(),   // the consensus the beat-probability is measured against
  sensitivity: z.array(z.object({ driver: z.string(), metric: MetricKey, contribution: z.number() })).default([]),
  watch_items: z.array(z.string()).default([]),
  watch: z.array(WatchItem).default([]), // control P6: typed sibling of watch_items (rides in append-only content jsonb)
  pbeat_divergence: z.string().nullable().optional(), // control P7: momentum-proxy note when model P(beat) diverges from the trailing beat rate
  provenance: z.array(ProvenanceRef).default([]),
});
export type Scenario = z.infer<typeof Scenario>;

export const Snapshot = z.object({
  snapshot_id: Uuid,
  as_of: IsoDate,
  cycle_label: z.string(),
  trigger: SnapshotTrigger,
  filing_ref: IdRef.nullable().optional(),
  fundamentals: Fundamentals.optional(),
  basis: BasisBlock.optional(), // control P11: per-line-item basis + FCF bridge + reconciliations
  market_context: MarketContext.optional(),
  hypotheses: Hypotheses.optional(),
  scenario: Scenario.optional(),
  brand_sentiment: BrandSentiment.optional(),
  signals: Signals.optional(),
  thesis: Thesis.optional(),
  events: z
    .object({
      earnings: z.array(OpenMap).default([]),
      filings: z.array(OpenMap).default([]),
    })
    .optional(),
});
export type Snapshot = z.infer<typeof Snapshot>;

// §4.2 forward pass: framed expectations + confirm/break conditions, staged into current_events
// as the next filing date approaches. The coverage pass measures the actual filing against it.
export const ForwardNote = z.object({
  as_of: IsoTimestamp,
  next_earnings_date: IsoDate.nullable(),
  expectations: z.string(),               // what the market expects / what this print needs to show
  focus_metrics: z.array(z.string()).default([]),
  confirm_conditions: z.array(z.string()).default([]),  // would CONFIRM the current thesis
  break_conditions: z.array(z.string()).default([]),    // would BREAK it (candidate invalidation triggers)
  source: z.string().default("forward_pass"),
});
export type ForwardNote = z.infer<typeof ForwardNote>;

export const CurrentEvents = z.object({
  rolling_outlook: z.string().default(""),
  last_monitored: IsoTimestamp.nullable().optional(),
  forward_note: ForwardNote.nullable().optional(),
  hypotheses: Hypotheses.nullable().optional(),
  notes: z.array(NewsNote).default([]),
});

/** §3.4 canonical company file: time-versioned; snapshots are append-only. */
export const CanonicalFile = z.object({
  company_id: Uuid,
  current_events: CurrentEvents,
  snapshots: z.array(Snapshot).default([]),
});
export type CanonicalFile = z.infer<typeof CanonicalFile>;

// ---------- §3.5 sector cohort file ----------
export const CohortFile = z.object({
  scope: z.object({
    gics_level: z.string(),
    value: z.string(),
    markets: z.array(z.string()).default([]),
  }),
  as_of: IsoDate,
  constituents: z.array(Uuid).default([]),
  comparative: OpenMap.optional(),
  positioning: OpenMap.optional(),
  sector_thesis: OpenMap.optional(),
  provenance: z.array(ProvenanceRef).default([]),
});
export type CohortFile = z.infer<typeof CohortFile>;
