// Raw landing zone (3.7) and provenance registry (section 8).

export type RawDocumentKind = 'filing' | 'transcript' | 'research' | 'news' | 'other';
export type SignalKind = 'price' | 'tradingview_alert';

export interface RawDocument {
  id: string;
  companyId: string;
  kind: RawDocumentKind;
  receivedAt: string;
  source: string;
  blobRef: string; // object storage key (DO Spaces)
  metadata: Record<string, unknown>;
}

export interface SignalEvent {
  id: string;
  companyId: string;
  ts: string;
  kind: SignalKind;
  payload: Record<string, unknown>; // raw alert JSON for TradingView
}

// Provenance source (section 8): every material claim links back to Tier 1.
export interface Source {
  id: string;
  rawDocumentId?: string;
  url?: string;
  locator?: string; // page/section/anchor within the source
  excerpt?: string;
  retrievedAt: string;
}
