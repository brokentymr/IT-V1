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

export const Thesis = z.object({
  one_liner: z.string(),
  long_form: z.string(),
  tensions: z.array(z.string()).default([]),
  catalysts: z
    .array(z.object({ event: z.string(), date: IsoDate.nullable(), expected_impact: z.string() }))
    .default([]),
  invalidation_triggers: z.array(z.string()).default([]),
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

export const Snapshot = z.object({
  snapshot_id: Uuid,
  as_of: IsoDate,
  cycle_label: z.string(),
  trigger: SnapshotTrigger,
  filing_ref: IdRef.nullable().optional(),
  fundamentals: Fundamentals.optional(),
  market_context: MarketContext.optional(),
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
