// Canonical Company File (3.4) — time-versioned; the substrate every output transforms.

import type { Position } from './company.ts';
import type { NewsNote } from './news-note.ts';

export type SnapshotTrigger = 'filing' | 'manual';

// --- current_events: maintained DAILY (4.3), rolls forward ---
export interface CurrentEvents {
  rollingOutlook: string | null; // the maintained forward view
  lastMonitored: string | null; // timestamp
  notes: NewsNote[]; // see 3.6
}

// --- fundamentals (ENGINE 2: Fundamental Research) ---
export interface Provenance {
  claimId: string;
  sourceRef: string;
}

export interface Fundamentals {
  statements: {
    incomeStatement?: unknown;
    balanceSheet?: unknown;
    cashFlow?: unknown;
    segments?: unknown;
  };
  capitalStructure: {
    debt: Array<{ instrument: string; amount: number; rate: number; maturity: string }>;
    netDebt?: number;
    leverageX?: number;
    governanceFlags: string[];
  };
  model: {
    normalizedMetrics: { ebitda?: number; fcf?: number; margins?: unknown; growth?: unknown };
    scenarios: {
      bear: { ev?: number; equity?: number; perShare?: number };
      base: { ev?: number; equity?: number; perShare?: number };
      bull: { ev?: number; equity?: number; perShare?: number };
    };
    valuationConclusion: { entryX?: number; fairX?: number; targetEquity?: number };
    drivers: Record<string, unknown>; // model-specific (margin bridge, halo engine, ...)
  };
  provenance: Provenance[];
}

// --- brand_sentiment (ENGINE 4) ---
export interface BrandSentiment {
  byPlatform: Array<{
    platform: string;
    volume: number;
    sentiment: number | string;
    trend: string;
    topThemes: string[];
  }>;
  groundMomentum: string;
  sentimentVsFundamentalsGap: { direction: string; magnitude: string };
  coverageWindow: { from: string; to: string }; // wider during event escalation (4.3)
  provenance: Provenance[];
}

// --- signals (ENGINE: Signal ingest) ---
export interface Signals {
  pricing: {
    last?: number;
    range52w?: [number, number];
    perf?: unknown;
    valuationVsPriceOverlay?: unknown;
  };
  tradingviewAlerts: Array<{
    ts: string;
    indicator: string;
    signal: string;
    timeframe: string;
    price: number;
    note?: string;
  }>;
  technicalContext: string; // price relative to thesis entry/fair/target
}

// --- thesis (synthesis of all engines) ---
export interface Thesis {
  oneLiner: string;
  longForm: string;
  tensions: string[];
  catalysts: Array<{ event: string; date: string; expectedImpact: string }>;
  invalidationTriggers: string[];
  conviction: number; // 1-5
  positionsHeld: Position[]; // inherited -> flows to every output
}

export interface CanonicalSnapshot {
  snapshotId: string;
  asOf: string; // ISO date
  cycleLabel: string; // e.g. "post-10Q-2026Q2"
  trigger: SnapshotTrigger;
  filingRef?: string;
  fundamentals: Fundamentals;
  brandSentiment: BrandSentiment;
  signals: Signals;
  thesis: Thesis;
  events: {
    earnings: Array<{ date: string; period: string; status: string }>;
    filings: Array<{ type: string; date: string; url: string; ref: string }>;
  };
  // section 8 reliability: every engine emits a confidence + missing-sources list
  confidence?: number;
  missingSources?: string[];
}

export interface CanonicalFile {
  companyId: string;
  currentEvents: CurrentEvents;
  snapshots: CanonicalSnapshot[]; // append-only (section 8)
}
