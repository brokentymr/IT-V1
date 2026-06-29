// Sector Cohort File (3.5) — produced by Engine 6.

import type { GicsLevel, MarketRegion } from './market.ts';
import type { Provenance } from './canonical-file.ts';

export interface CohortFile {
  scope: { gicsLevel: GicsLevel; value: string; markets: MarketRegion[] };
  asOf: string;
  constituents: string[]; // company_id[]
  comparative: {
    valuationTable: unknown;
    marginStructure: unknown;
    growthTable: unknown;
    sentimentTable: unknown;
  };
  positioning: {
    leaders: string[]; // company_id[]
    laggards: string[]; // company_id[]
    valueOpportunity: string;
    divergences: string[];
  };
  sectorThesis: {
    strengths: string[];
    weaknesses: string[];
    whereTheOpportunityIs: string;
  };
  provenance: Provenance[];
}
