/**
 * Model coherence (pipeline upgrade — docs/UPGRADE-pipeline-rearchitecture.md §5).
 *
 * The Micron report carried two "quantitative" artifacts that never spoke to each other: LLM-asserted
 * driver impacts (single-digit swings) and a Monte Carlo whose P50 implied +28% growth. A real model
 * has ONE internally consistent engine. Until the full grounded driver-tree exists, this at least
 * MEASURES whether the drivers and the scenario tell the same story and flags incoherence to the desk
 * and the report, so precision theater can't pass unchallenged. Pure — no LLM.
 */

export interface DriverLike {
  metric: string; // "revenue" | "gross_margin" | ...
  impact_pct: { bear: number; base: number; bull: number }; // percentage points, signed
}

export interface GrowthBand {
  p10: number;
  p50: number;
  p90: number;
} // fractions (0.28 = +28%)

export interface Coherence {
  driverImpliedGrowthPct: { bear: number; base: number; bull: number } | null;
  mcImpliedGrowthPct: { p10: number; p50: number; p90: number } | null;
  agree: boolean;
  note: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const sign = (n: number, dead = 2) => (n > dead ? 1 : n < -dead ? -1 : 0);

/**
 * Reconcile the revenue drivers' aggregate impact against the Monte Carlo revenue-growth bands.
 * `agree` is true when the two point the same way and the MC median sits inside the driver-implied
 * range (with a buffer). Missing inputs → agree (nothing to reconcile), with an explanatory note.
 */
export function reconcileScenario(drivers: DriverLike[], revenueGrowthBands: GrowthBand | null, buffer = 15): Coherence {
  const revDrivers = drivers.filter((d) => d.metric === "revenue");
  if (!revDrivers.length || !revenueGrowthBands) {
    return { driverImpliedGrowthPct: null, mcImpliedGrowthPct: null, agree: true, note: "Insufficient inputs to reconcile drivers against the scenario." };
  }

  const di = {
    bear: round1(revDrivers.reduce((s, d) => s + d.impact_pct.bear, 0)),
    base: round1(revDrivers.reduce((s, d) => s + d.impact_pct.base, 0)),
    bull: round1(revDrivers.reduce((s, d) => s + d.impact_pct.bull, 0)),
  };
  const mc = {
    p10: round1(revenueGrowthBands.p10 * 100),
    p50: round1(revenueGrowthBands.p50 * 100),
    p90: round1(revenueGrowthBands.p90 * 100),
  };

  const sameDirection = sign(di.base) === sign(mc.p50);
  const lo = Math.min(di.bear, di.bull) - buffer;
  const hi = Math.max(di.bear, di.bull) + buffer;
  const inRange = mc.p50 >= lo && mc.p50 <= hi;
  const agree = sameDirection && inRange;

  const summary = `Drivers imply ${di.base >= 0 ? "+" : ""}${di.base}% base revenue growth (bear ${di.bear}% / bull ${di.bull}%); Monte Carlo P50 ${mc.p50 >= 0 ? "+" : ""}${mc.p50}% (P10 ${mc.p10}% / P90 ${mc.p90}%).`;
  const note = agree
    ? `${summary} Broadly coherent.`
    : `${summary} INCOHERENT — the two quantitative views disagree (${!sameDirection ? "opposite direction" : "MC median outside the driver-implied range"}); the scenario is not internally consistent with the drivers. Treat the numbers with caution and do not present them as a single model.`;

  return { driverImpliedGrowthPct: di, mcImpliedGrowthPct: mc, agree, note };
}
