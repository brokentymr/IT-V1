/**
 * Desk quality scorecard (pipeline upgrade §7). Scores the latest snapshot of each covered company on
 * the four failures the Micron review surfaced — true-data rejection, grounded coverage, decision
 * completeness, model coherence — and prints a report card. Usage: npm run eval:desk [TICKER]
 */
import { loadEnv } from "../lib/env";
import { query, closePool } from "../lib/db/pool";
import { evaluateSnapshot, type EvalContent, type Grade } from "../lib/eval/desk_eval";

loadEnv();

const ticker = process.argv[2];
const rows = (
  await query<{ ticker: string | null; legal_name: string; as_of: string; content: EvalContent }>(
    `SELECT c.primary_ticker AS ticker, c.legal_name, s.as_of::text AS as_of, s.content
       FROM canonical_snapshots s JOIN companies c ON c.id = s.company_id
      ${ticker ? "WHERE upper(c.primary_ticker) = upper($1)" : ""}
      ORDER BY c.primary_ticker, s.as_of DESC, s.created_at DESC`,
    ticker ? [ticker] : [],
  )
).rows;

// Latest snapshot per company.
const seen = new Set<string>();
const latest = rows.filter((r) => {
  const key = r.ticker ?? r.legal_name;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

if (!latest.length) {
  console.log(ticker ? `No snapshot found for ${ticker}.` : "No snapshots to score.");
} else {
  const dist: Record<Grade, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  console.log(`\nDesk quality scorecard — ${latest.length} name(s)\n${"=".repeat(60)}`);
  for (const r of latest) {
    const s = evaluateSnapshot(r.content);
    dist[s.grade]++;
    const cov = `${(s.groundedCoverage * 100).toFixed(0)}%`;
    const coh = s.coherent === null ? "n/a" : s.coherent ? "ok" : "INCOHERENT";
    console.log(
      `\n[${s.grade}] ${r.ticker ?? r.legal_name} (${r.as_of})` +
        `\n     grounded ${cov} · decided ${s.decisionComplete ? "yes" : "NO"} · coherence ${coh} · true-data-rejection ${s.trueDataRejection ? "YES ⚠" : "no"}` +
        (s.issues.length ? `\n     issues: ${s.issues.join("; ")}` : ""),
    );
  }
  console.log(`\n${"=".repeat(60)}\nGrades: ` + (Object.entries(dist).filter(([, n]) => n > 0).map(([g, n]) => `${g}×${n}`).join("  ")) + "\n");
}

await closePool();
process.exit(0);
