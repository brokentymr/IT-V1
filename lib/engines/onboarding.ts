/**
 * Auto-on-add onboarding (level-up B). When an asset is added we run the whole pipeline to "build
 * clarity" automatically, then stop at the §8 human checkpoint (approval → content). A listed name gets
 * coverage → monitor → sentiment → price; an unlisted name gets a research profile. Each step degrades
 * independently (a dead adapter fails one step, not the run) and is recorded so the consumer surface can
 * show a live progress strip. Runners are injectable so the orchestration is deterministic in tests.
 */
import { query } from "../db/pool";

export interface OnboardStep { step: string; status: "ok" | "skipped" | "failed"; detail: string; ts: string }

export interface OnboardRunners {
  coverage: (companyId: string) => Promise<string>; // returns a short detail (e.g. snapshot/cycle)
  monitor: (companyId: string) => Promise<string>;
  sentiment: (companyId: string) => Promise<string>;
  price: (companyId: string) => Promise<string>;
  profile: (companyId: string) => Promise<string>;
}

export interface OnboardResult { run_id: string; company_id: string; steps: OnboardStep[]; status: "done" | "failed" }

const nowIso = () => new Date().toISOString();

export async function runOnboarding(opts: { companyId: string; runners: OnboardRunners }): Promise<OnboardResult> {
  const c = await query<{ id: string; listing: string; cik: string | null; primary_ticker: string | null }>(
    "SELECT id, listing, cik, primary_ticker FROM companies WHERE id = $1", [opts.companyId],
  );
  if (!c.rows[0]) throw new Error(`company ${opts.companyId} not found`);
  const co = c.rows[0];
  const listed = co.listing === "listed" && !!co.cik;

  const run = await query<{ id: string }>(
    "INSERT INTO onboarding_runs (company_id, status) VALUES ($1,'running') RETURNING id", [opts.companyId],
  );
  const runId = run.rows[0].id;
  const steps: OnboardStep[] = [];

  // Building clarity — surface it immediately.
  await query("UPDATE companies SET coverage_status = 'in_research', coverage = jsonb_set(coverage,'{status}','\"in_research\"') WHERE id = $1", [opts.companyId]);

  const record = async (step: string, run: () => Promise<string>): Promise<void> => {
    let entry: OnboardStep;
    try {
      const detail = await run();
      entry = { step, status: "ok", detail, ts: nowIso() };
    } catch (e) {
      entry = { step, status: "failed", detail: (e as Error).message.slice(0, 140), ts: nowIso() };
    }
    steps.push(entry);
    await query("UPDATE onboarding_runs SET steps = $2 WHERE id = $1", [runId, JSON.stringify(steps)]).catch(() => {});
  };
  const skip = async (step: string, detail: string): Promise<void> => {
    steps.push({ step, status: "skipped", detail, ts: nowIso() });
    await query("UPDATE onboarding_runs SET steps = $2 WHERE id = $1", [runId, JSON.stringify(steps)]).catch(() => {});
  };

  if (listed) {
    await record("fundamentals", () => opts.runners.coverage(opts.companyId));
    await record("news", () => opts.runners.monitor(opts.companyId));
    await record("sentiment", () => opts.runners.sentiment(opts.companyId));
    await record("price", () => opts.runners.price(opts.companyId));
  } else {
    await record("profile", () => opts.runners.profile(opts.companyId));
    await skip("fundamentals", "no SEC filings — unlisted");
  }

  // Ready for your review — the research is built; the §8 checkpoint (approval) is next.
  await query("UPDATE companies SET coverage_status = 'in_review', coverage = jsonb_set(coverage,'{status}','\"in_review\"') WHERE id = $1", [opts.companyId]);
  const status: "done" | "failed" = steps.some((s) => s.status === "failed") && !steps.some((s) => s.status === "ok") ? "failed" : "done";
  await query("UPDATE onboarding_runs SET status = $2, finished_at = now(), steps = $3 WHERE id = $1", [runId, status, JSON.stringify(steps)]);

  return { run_id: runId, company_id: opts.companyId, steps, status };
}

/** Latest onboarding run for a company (for the progress strip). */
export async function latestOnboarding(companyId: string): Promise<{ status: string; steps: OnboardStep[]; started_at: string } | null> {
  const { rows } = await query<{ status: string; steps: OnboardStep[]; started_at: string }>(
    "SELECT status, steps, to_char(started_at,'YYYY-MM-DD\"T\"HH24:MI:SS') AS started_at FROM onboarding_runs WHERE company_id = $1 ORDER BY started_at DESC LIMIT 1",
    [companyId],
  );
  return rows[0] ?? null;
}
