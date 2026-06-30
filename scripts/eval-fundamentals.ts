// Eval harness for Engine 2 (Phase 4 testing milestone). Runs a REAL coverage pass on a ticker's
// latest covered filing (live EDGAR + the Claude analyst, Haiku under LLM_MODEL_OVERRIDE), then
// scores the produced snapshot on the four milestone dimensions:
//   1. statement extraction   2. provenance coverage   3. schema conformance   4. invalidation triggers
// Usage: npm run eval:fundamentals -- AAPL
import { loadEnv } from "../lib/env";
import { query, closePool } from "../lib/db/pool";
import { stopBoss } from "../lib/queue/boss";
import { SecAdapter } from "../lib/sources/sec";
import { ClaudeFundamentalsAnalyst } from "../lib/engines/fundamentals_analyst";
import { ClaudeNewsAnalyzer } from "../lib/engines/analyzer";
import { PerplexityFinance } from "../lib/sources/perplexity";
import { runCoveragePass } from "../lib/engines/fundamental_research";
import { FUNDAMENTALS_CONFIG } from "../lib/config/fundamentals";
import { Thesis, Fundamentals } from "../lib/types";
import { llmSpendThisMonth } from "../lib/llm/client";

loadEnv();
const ticker = (process.argv.slice(2).find((a) => !a.startsWith("-")) ?? "AAPL").toUpperCase();

interface Check { name: string; pass: boolean; detail: string }
// A trigger is "specific" if it is quantitative (a number/level) OR names a concrete, observable
// event/metric — not vague ("thesis breaks"). Both quantitative and event-based triggers qualify.
const SPECIFIC =
  /\d|%|\$|margin|revenue|guidance|growth|eps|cash|debt|share|withdraw|disclos|announce|delay|launch|lower|raise|\bcut\b|miss|below|above|decline|decelerat|soften|exceed/i;

try {
  const { rows } = await query<{ id: string; cik: string | null }>(
    "SELECT id, cik FROM companies WHERE upper(primary_ticker) = $1", [ticker],
  );
  const company = rows[0];
  if (!company?.cik) throw new Error(`${ticker} is not a covered company with a CIK`);

  const sec = new SecAdapter();
  const filings = await sec.recentFilings(company.cik, { forms: FUNDAMENTALS_CONFIG.triggerForms });
  const latest = filings.data?.find((f) => /^10-[KQ]$/.test(f.form)) ?? filings.data?.[0];
  if (!latest) throw new Error(`no covered filing found for ${ticker}`);
  console.error(`[eval] ${ticker}: scoring coverage pass on ${latest.form} ${latest.accession} (${latest.filing_date})`);

  const before = await llmSpendThisMonth();
  const r = await runCoveragePass({
    companyId: company.id, accession: latest.accession, formType: latest.form, filingUrl: latest.url,
    analyst: new ClaudeFundamentalsAnalyst(), newsAnalyzer: new ClaudeNewsAnalyzer(),
    finance: new PerplexityFinance(), sec, trigger: "manual",
  });
  const after = await llmSpendThisMonth();

  const snap = await query<{ content: Record<string, unknown>; diff: { metrics: unknown[] } }>(
    "SELECT content, diff FROM canonical_snapshots WHERE snapshot_id = $1", [r.snapshot_id],
  );
  const content = snap.rows[0].content as { fundamentals?: Record<string, unknown>; thesis?: Record<string, unknown> };
  const fundamentals = content.fundamentals as { model?: { line_items?: Record<string, { value: number; accession: string | null }>; ratios?: Record<string, number> }; provenance?: unknown[] };
  const items = fundamentals?.model?.line_items ?? {};
  const thesis = content.thesis as { invalidation_triggers?: string[] } | undefined;

  const checks: Check[] = [];

  // 1. statement extraction — headline flow items present + sane.
  const rev = items.revenue?.value, ni = items.net_income?.value;
  checks.push({
    name: "statement extraction",
    pass: !!rev && rev > 1e9 && !!ni && Object.keys(items).length >= 3,
    detail: `extracted ${Object.keys(items).length} line items; revenue=${rev?.toLocaleString() ?? "—"} net_income=${ni?.toLocaleString() ?? "—"}; missing=[${r.missing_metrics.join(",")}]`,
  });

  // 2. provenance — every line item sourced (has an accession) + provenance array covers all items.
  const allSourced = Object.values(items).every((li) => !!li.accession);
  checks.push({
    name: "provenance coverage",
    pass: allSourced && (fundamentals?.provenance?.length ?? 0) === Object.keys(items).length,
    detail: `${fundamentals?.provenance?.length ?? 0}/${Object.keys(items).length} claims carry a source_ref; all line items accession-tagged=${allSourced}`,
  });

  // 3. schema conformance — snapshot sub-blocks validate against the §3 contract.
  const tOk = Thesis.safeParse(content.thesis);
  const fOk = Fundamentals.safeParse(content.fundamentals);
  checks.push({
    name: "schema conformance",
    pass: tOk.success && fOk.success,
    detail: `thesis=${tOk.success ? "ok" : tOk.error.issues[0]?.message} fundamentals=${fOk.success ? "ok" : fOk.error.issues[0]?.message}`,
  });

  // 4. invalidation triggers — present and specific.
  const trig = thesis?.invalidation_triggers ?? [];
  const specific = trig.filter((t) => SPECIFIC.test(t));
  checks.push({
    name: "invalidation triggers",
    pass: trig.length >= 1 && specific.length === trig.length,
    detail: `${trig.length} trigger(s), ${specific.length} specific: ${JSON.stringify(trig)}`,
  });

  const passed = checks.filter((c) => c.pass).length;
  console.log(`\n=== Engine 2 eval — ${ticker} ${latest.form} ${latest.accession} ===`);
  for (const c of checks) console.log(`  [${c.pass ? "PASS" : "FAIL"}] ${c.name}: ${c.detail}`);
  console.log(`\nScore: ${passed}/${checks.length} | snapshot ${r.snapshot_id} | diff metrics ${snap.rows[0].diff.metrics.length} | read-through ${r.read_through_notes} | links +${r.links_enriched}`);
  console.log(`LLM cost this run: $${(after - before).toFixed(4)} (month $${after.toFixed(4)})`);
  if (passed < checks.length) process.exitCode = 1;
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await stopBoss().catch(() => {});
  await closePool();
}
