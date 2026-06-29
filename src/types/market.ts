// Market (3.2) and GICS taxonomy (3.1).

export type MarketRegion = 'NA' | 'EMEA' | 'APAC' | 'LATAM';
export type FilingSystem = 'SEC_EDGAR' | 'UK_NSM' | 'EDINET' | 'OTHER';
export type GicsLevel = 'sector' | 'industry_group' | 'industry' | 'sub_industry';

export interface Market {
  id: string;
  exchange: string; // NYSE, NASDAQ, LSE, TSE, HKEX
  country: string; // US, UK, JP
  region: MarketRegion;
  currency: string; // USD, GBP, JPY
  calendarRef?: string; // exchange + earnings calendar
  primaryFilingSystem: FilingSystem;
}

// Sector (11) -> Industry Group (25) -> Industry (74) -> Sub-Industry (163).
export interface GicsClassification {
  id: string;
  code: string;
  name: string;
  level: GicsLevel;
  parentId: string | null;
}

// The full GICS path stored on every company (3.1, 3.3).
export interface GicsPath {
  gicsSector: string;
  industryGroup: string;
  industry: string;
  subIndustry: string;
}
