// Verification: prove the verified-price anchor + staleness guard changes the desk's positioning
// decision on CAVA's real report. Fetches a LIVE Yahoo price, builds the price context against the
// snapshot's $84.70 sell-side target, then runs the positioning desk A/B — without vs. with the
// context — on the actual CAVA thesis/scenario pulled from the latest snapshot.
//
//   npx tsx scripts/verify-price-context.ts
import { loadEnv } from "../lib/env";
loadEnv();
import { query } from "../lib/db/pool";
import { PriceAdapter } from "../lib/sources/prices";
import { buildPriceContext } from "../lib/engines/price_context";
import { ClaudePositioningDesk, type PositioningInput } from "../lib/engines/positioning";

const TICKER = "CAVA";

async function main() {
  // 1. The real report frame: pull CAVA's latest snapshot thesis + scenario + market context.
  const { rows } = await query<{ content: any }>(
    `SELECT content FROM canonical_snapshots s JOIN companies c ON c.id = s.company_id
      WHERE c.primary_ticker = $1 ORDER BY s.created_at DESC LIMIT 1`,
    [TICKER],
  );
  if (!rows.length) throw new Error("no CAVA snapshot found");
  const c = rows[0].content;
  const target = c.market_context?.analyst_view?.price_target_usd ?? 84.7;
  const rg = c.scenario?.bands?.revenue_growth;
  const eps = c.scenario?.bands?.eps;
  const scenarioSummary = rg
    ? `revenue growth P10/P50/P90 ${(rg.p10 * 100).toFixed(0)}/${(rg.p50 * 100).toFixed(0)}/${(rg.p90 * 100).toFixed(0)}%; EPS P10/P50/P90 ${eps ? `${eps.p10.toFixed(2)}/${eps.p50.toFixed(2)}/${eps.p90.toFixed(2)}` : "n/a"}; coherence: ${c.scenario?.coherence?.note ?? "n/a"}`
    : "no scenario available";

  // 2. LIVE price fetch + context (this is the new pipeline stage, run for real).
  const bars = await new PriceAdapter().dailyBars(TICKER);
  const barData = bars.ok ? bars.data ?? [] : null;
  const ctx = buildPriceContext({ bars: barData, analystTarget: target });
  console.log("\n=== VERIFIED PRICE CONTEXT (live Yahoo) ===");
  console.log(`  fetched ok:      ${bars.ok}  (${barData ? barData.length + " bars" : bars.missing.join("; ")})`);
  console.log(`  current_price:   $${ctx.current_price}  (as of ${ctx.as_of})`);
  console.log(`  2m low / high:   $${ctx.low_2m} / $${ctx.high_2m}   off-low ${ctx.off_low_pct != null ? (ctx.off_low_pct * 100).toFixed(0) + "%" : "—"}`);
  console.log(`  30d return:      ${ctx.ret_30d != null ? (ctx.ret_30d * 100).toFixed(0) + "%" : "—"}`);
  console.log(`  sell-side target:$${ctx.analyst_target}   gap ${ctx.target_gap_pct != null ? (ctx.target_gap_pct * 100).toFixed(0) + "%" : "—"} above spot`);
  console.log(`  market_repriced: ${ctx.market_repriced}   stale_frame: ${ctx.stale_frame}`);
  console.log(`  note:            ${ctx.note}`);

  const baseInput: PositioningInput = {
    company: { legal_name: "CAVA GROUP, INC.", ticker: TICKER, listing: "listed" },
    thesis: {
      one_liner: c.thesis.one_liner,
      long_form: c.thesis.long_form,
      conviction: c.thesis.conviction ?? 3,
      key_debates: c.key_debates ?? [],
      invalidation_triggers: c.thesis.invalidation_triggers ?? [],
    },
    verification: { confidence: 0.62, grounded_coverage: 0.7 },
    scenario_summary: scenarioSummary,
    market_context: JSON.stringify({ consensus: c.market_context?.consensus, analyst_view: c.market_context?.analyst_view }),
    next_earnings_date: "2026-08-11",
  };

  const desk = new ClaudePositioningDesk();
  console.log("\n=== A: positioning WITHOUT verified price context (old behavior) ===");
  const a = await desk.decide(baseInput);
  summarize(a);

  console.log("\n=== B: positioning WITH verified price context (new) ===");
  const b = await desk.decide({
    ...baseInput,
    price_context: {
      current_price: ctx.current_price, as_of: ctx.as_of, analyst_target: ctx.analyst_target,
      target_gap_pct: ctx.target_gap_pct, market_repriced: ctx.market_repriced, note: ctx.note,
    },
  });
  summarize(b);

  console.log("\n=== DELTA ===");
  console.log(`  stance:          ${a.strategic_stance}  ->  ${b.strategic_stance}`);
  console.log(`  conviction:      ${a.conviction}  ->  ${b.conviction}`);
  console.log(`  expected_return: ${a.expected_return_pct}%  ->  ${b.expected_return_pct}%`);
  console.log(`  target (base):   ${a.price_target.base}  ->  ${b.price_target.base}`);
  console.log(`  auto-commit gate: WITH ctx, stale_frame=${ctx.stale_frame} + bullish=${["strong_long","constructive"].includes(b.strategic_stance)} => ${ctx.stale_frame && ["strong_long","constructive"].includes(b.strategic_stance) ? "HELD FOR REVIEW" : "clears"}`);
  process.exit(0);
}

function summarize(d: any) {
  console.log(`  stance:          ${d.strategic_stance} (conviction ${d.conviction}/5)`);
  console.log(`  tactical:        ${d.tactical_stance}`);
  console.log(`  expected_return: ${d.expected_return_pct}%   risk/reward ${d.risk_reward}   target ${JSON.stringify(d.price_target)}`);
  console.log(`  variant_view:    ${d.variant_view}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
