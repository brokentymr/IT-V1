// News Note (3.6) — the rolling current-events record (primary + read-through).

import type { LinkType } from './company-link.ts';

export type NewsCategory =
  | 'guidance'
  | 'product'
  | 'management'
  | 'legal_regulatory'
  | 'macro'
  | 'm_and_a'
  | 'capital_markets'
  | 'other';

export type NoteOriginKind = 'primary' | 'read_through';
export type ThesisEffect = 'supports' | 'pressures' | 'neutral' | 'invalidates';
export type Magnitude = 'low' | 'medium' | 'high';
export type NoteStatus = 'logged' | 'flagged' | 'escalated';

export interface ReadThrough {
  affectedCompanyId: string;
  linkType: LinkType;
  expectedEffect: string;
  materiality: Magnitude;
}

export interface NewsNote {
  id: string;
  companyId: string; // the asset this note is ABOUT
  detectedAt: string; // timestamp
  sourceRef?: string; // provenance to Tier 1
  headline: string;
  summary: string; // plain language
  category: NewsCategory;

  origin: {
    kind: NoteOriginKind;
    originEventRef: string | null; // if read_through: originating note on another asset
    originCompanyId: string | null; // if read_through: the asset the event happened to
    linkType: LinkType | null; // the relationship edge it traveled
  };

  importanceScore: number; // 0-100, rubric in 4.3 (band derived from config)
  importanceRationale: string;

  impactAnalysis: {
    forwardOutlook: string;
    thesisEffect: ThesisEffect;
    invalidationTriggerHit: string | null;
    sentimentEffect: string;
    estimatedMagnitude: Magnitude;
  };

  readThrough: ReadThrough[]; // outbound read-throughs raised from this note
  status: NoteStatus;

  escalation: {
    triggered: boolean;
    type?: 'sentiment_run';
    windowDays?: number;
    jobRef?: string | null;
  };

  carriedInto: string | null; // snapshot_id
}
