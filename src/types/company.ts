// Company index record (3.3) — the atomic node of the graph.

import type { GicsPath, Market } from './market.ts';

export type CoverageStatus =
  | 'watchlist'
  | 'queued'
  | 'in_research'
  | 'in_review'
  | 'published'
  | 'monitoring';

export interface Position {
  instrument: string;
  direction: string;
  size: number | string;
  asOf: string; // ISO date
}

export interface CompanyIdentifiers {
  legalName: string;
  tickers: string[];
  isin?: string;
  cik?: string;
  lei?: string;
}

export interface CompanyCoverage {
  status: CoverageStatus;
  authors: string[]; // attribution metadata only
  nextEarningsDate?: string; // ISO date
  positionsHeld: Position[];
}

export interface Company {
  id: string;
  identifiers: CompanyIdentifiers;
  classification: GicsPath;
  markets: Market[];
  tradingviewSymbol?: string; // e.g. "NYSE:REF" — for alert routing
  coverage: CompanyCoverage;
  canonicalFileRef?: string;
  contentRefs: string[];
}
