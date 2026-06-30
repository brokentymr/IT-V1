/**
 * SIC → GICS best-effort crosswalk (Phase 1 classification decision).
 * SEC EDGAR gives a 4-digit SIC; GICS must be assigned. Specific 4-digit ranges
 * (high confidence, group-level) take priority; a 2-digit major-group fallback
 * gives sector-level (medium confidence); anything unmatched is low confidence.
 *
 * Confidence feeds companies.classification_confidence and flags low-confidence
 * classifications for review (the reliability guardrail, spec §8).
 */

export interface SicMatch {
  sector_code: string | null;
  group_code: string | null;
  confidence: number; // 0..1
}

interface Rule { lo: number; hi: number; sector: string; group: string | null; conf: number }

// Most-specific first; first match wins.
const SPECIFIC: Rule[] = [
  { lo: 3570, hi: 3579, sector: "45", group: "4520", conf: 0.9 },  // computers & office equipment (AAPL 3571, HPQ 3570)
  { lo: 3674, hi: 3674, sector: "45", group: "4530", conf: 0.9 },  // semiconductors
  { lo: 3670, hi: 3679, sector: "45", group: "4520", conf: 0.85 }, // electronic components
  { lo: 3661, hi: 3669, sector: "45", group: "4520", conf: 0.85 }, // communications equipment
  { lo: 7372, hi: 7372, sector: "45", group: "4510", conf: 0.9 },  // prepackaged software
  { lo: 7370, hi: 7379, sector: "45", group: "4510", conf: 0.85 }, // computer services
  { lo: 2833, hi: 2836, sector: "35", group: "3520", conf: 0.9 },  // pharma / biologics
  { lo: 8731, hi: 8731, sector: "35", group: "3520", conf: 0.75 }, // commercial biological research
  { lo: 3840, hi: 3851, sector: "35", group: "3510", conf: 0.85 }, // medical devices & instruments
  { lo: 8000, hi: 8099, sector: "35", group: "3510", conf: 0.8 },  // health services
  { lo: 6798, hi: 6798, sector: "60", group: "6010", conf: 0.9 },  // REITs
  { lo: 6500, hi: 6599, sector: "60", group: "6020", conf: 0.85 }, // real estate
  { lo: 6020, hi: 6099, sector: "40", group: "4010", conf: 0.85 }, // banks / depository
  { lo: 6300, hi: 6411, sector: "40", group: "4030", conf: 0.85 }, // insurance
  { lo: 6200, hi: 6299, sector: "40", group: "4020", conf: 0.85 }, // brokers / exchanges
  { lo: 6700, hi: 6799, sector: "40", group: "4020", conf: 0.7 },  // investment offices (6798 carved above)
  { lo: 4830, hi: 4841, sector: "50", group: "5020", conf: 0.85 }, // broadcasting / cable
  { lo: 4800, hi: 4899, sector: "50", group: "5010", conf: 0.85 }, // telecom
  { lo: 2700, hi: 2741, sector: "50", group: "5020", conf: 0.7 },  // publishing
  { lo: 7800, hi: 7841, sector: "50", group: "5020", conf: 0.8 },  // motion pictures
  { lo: 4900, hi: 4999, sector: "55", group: "5510", conf: 0.9 },  // utilities
  { lo: 1300, hi: 1399, sector: "10", group: "1010", conf: 0.9 },  // oil & gas extraction
  { lo: 2910, hi: 2911, sector: "10", group: "1010", conf: 0.85 }, // petroleum refining
  { lo: 1220, hi: 1241, sector: "10", group: "1010", conf: 0.8 },  // coal mining
  { lo: 3710, hi: 3716, sector: "25", group: "2510", conf: 0.85 }, // motor vehicles
  { lo: 5800, hi: 5899, sector: "25", group: "2530", conf: 0.8 },  // restaurants
  { lo: 7000, hi: 7099, sector: "25", group: "2530", conf: 0.8 },  // hotels
  { lo: 7900, hi: 7999, sector: "25", group: "2530", conf: 0.75 }, // recreation services
  { lo: 5400, hi: 5499, sector: "30", group: "3010", conf: 0.85 }, // food stores
  { lo: 5912, hi: 5912, sector: "30", group: "3010", conf: 0.85 }, // drug stores
  { lo: 2000, hi: 2199, sector: "30", group: "3020", conf: 0.85 }, // food & tobacco
];

// 2-digit SIC major group → GICS sector (medium confidence; group unresolved).
const MAJOR: Record<number, string> = {
  1: "30", 2: "30", 7: "30", 8: "15", 9: "30",
  10: "15", 14: "15", 12: "10", 13: "10",
  15: "20", 16: "20", 17: "20",
  20: "30", 21: "30", 22: "25", 23: "25",
  24: "15", 26: "15", 28: "15", 30: "15", 32: "15", 33: "15",
  25: "25", 31: "25", 39: "25", 27: "50", 29: "10",
  34: "20", 35: "20", 36: "20", 37: "20", 38: "20",
  40: "20", 41: "20", 42: "20", 44: "20", 45: "20", 46: "20", 47: "20",
  48: "50", 49: "55", 50: "20", 51: "20",
  52: "25", 53: "25", 54: "30", 55: "25", 56: "25", 57: "25", 58: "25", 59: "25",
  60: "40", 61: "40", 62: "40", 63: "40", 64: "40", 67: "40", 65: "60",
  70: "25", 72: "25", 73: "20", 75: "25", 76: "20", 78: "50", 79: "25",
  80: "35", 81: "20", 82: "25", 83: "25", 87: "20",
};

export function classifyBySic(sic: string | number | null | undefined): SicMatch {
  if (sic === null || sic === undefined || sic === "") {
    return { sector_code: null, group_code: null, confidence: 0 };
  }
  const n = parseInt(String(sic).trim(), 10);
  if (!Number.isFinite(n)) return { sector_code: null, group_code: null, confidence: 0 };

  for (const r of SPECIFIC) {
    if (n >= r.lo && n <= r.hi) return { sector_code: r.sector, group_code: r.group, confidence: r.conf };
  }
  const major = Math.floor(n / 100);
  const sector = MAJOR[major];
  if (sector) return { sector_code: sector, group_code: null, confidence: 0.6 };
  return { sector_code: null, group_code: null, confidence: 0.2 };
}
