/**
 * Entity-gate configuration (control P8) — config-not-code, tunable without a rebuild.
 *
 * The gate exists to stop false-positive news matches on collision-prone tickers. A ticker is
 * "collision-prone" when it is very short (<= maxCollisionTickerLen) OR appears in the hand-curated
 * denylist of tickers that spell common English words / abbreviations (MU, GM, F, A, ALL, ...). For
 * those and ONLY those, a headline must carry >= minEntitySignals distinctive company signals (a
 * suffix-stripped legal-name token, a $TICKER cashtag or exchange mention, or a GICS sector term)
 * before we spend an LLM classification on it. Every other ticker passes the gate unconditionally —
 * the gate is a strict no-op for normal 3–5 letter tickers so it can never regress existing coverage.
 */
import { MONITOR_CONFIG } from "./monitor";

export interface EntityGateConfig {
  /** Minimum distinctive company signals a headline needs to clear the gate (collision-prone tickers only). */
  minEntitySignals: number;
  /** Tickers that spell common words / abbreviations — always collision-prone regardless of length. */
  collisionTickers: string[];
  /** Tickers this length or shorter are collision-prone by default. */
  maxCollisionTickerLen: number;
  /** Legal-name suffix tokens stripped before extracting a distinctive name token. */
  nameSuffixStopwords: string[];
  /** GICS sector → sector-defining terms that count as one entity signal when present. */
  sectorTermSynonyms: Record<string, string[]>;
  /** A `category:'other'` note below this importance is suppressed from the feed & sentiment scoring. */
  otherCategoryImportanceFloor: number;
}

export const ENTITY_GATE: EntityGateConfig = {
  minEntitySignals: 2,
  // Short and/or word-like US tickers that routinely collide with ordinary prose.
  collisionTickers: [
    "MU", "GM", "F", "A", "ALL", "IT", "ON", "SO", "DD", "GO", "BE", "AI",
    "KEY", "CAT", "CAR", "LUV", "NOW", "SEE", "FUN", "PLAY",
  ],
  maxCollisionTickerLen: 2,
  nameSuffixStopwords: [
    "Inc", "Inc.", "Corp", "Corp.", "Corporation", "Co", "Co.", "Company", "Ltd", "Ltd.", "Limited",
    "Holdings", "Technology", "Technologies", "Group", "plc", "PLC", "LLC", "LP", "SA", "AG", "NV", "The",
  ],
  sectorTermSynonyms: {
    "Information Technology": ["semiconductor", "chip", "chips", "software", "hardware", "cloud", "computing", "electronics", "tech", "technology"],
    "Health Care": ["drug", "pharma", "pharmaceutical", "biotech", "clinical", "therapy", "therapeutic", "medical", "medicine", "fda"],
    "Financials": ["bank", "banking", "lending", "insurance", "insurer", "brokerage", "credit", "loan", "mortgage"],
    "Energy": ["oil", "gas", "drilling", "refinery", "refining", "crude", "pipeline", "petroleum", "energy"],
    "Consumer Discretionary": ["retail", "retailer", "apparel", "automotive", "vehicle", "restaurant", "ecommerce", "consumer"],
    "Consumer Staples": ["grocery", "food", "beverage", "household", "staples", "packaged"],
    "Industrials": ["manufacturing", "industrial", "machinery", "aerospace", "defense", "logistics", "freight", "construction"],
    "Materials": ["mining", "miner", "chemical", "chemicals", "steel", "metals", "materials", "commodity"],
    "Communication Services": ["media", "streaming", "advertising", "telecom", "telecommunications", "wireless", "broadband", "gaming"],
    "Utilities": ["utility", "electric", "power", "grid", "renewable", "water"],
    "Real Estate": ["reit", "property", "properties", "leasing"],
  },
  otherCategoryImportanceFloor: MONITOR_CONFIG.bands.flag, // reuse the 40 "flag" band as the feed/scoring floor
};
