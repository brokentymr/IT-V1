// Company relationship / link (3.8) — the edges read-through analysis traverses.

export type LinkType =
  | 'competitor'
  | 'supplier'
  | 'customer'
  | 'parent'
  | 'subsidiary'
  | 'jv_partner'
  | 'shared_end_market'
  | 'thematic_peer'
  | 'macro_correlated';

export type LinkStrength = 'weak' | 'medium' | 'strong';
export type LinkStatus = 'active' | 'stale' | 'unverified';

export interface CompanyLink {
  id: string;
  fromCompanyId: string; // the source asset
  toCompanyId: string; // the asset that may be affected
  type: LinkType;
  crossSector: boolean; // true if the two sit in different GICS sectors
  strength: LinkStrength;
  directionNote?: string; // how impact tends to flow
  rationale?: string;
  sourceRef?: string; // provenance
  status: LinkStatus;
}
