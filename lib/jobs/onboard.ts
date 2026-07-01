/**
 * ONBOARD_ASSET job handler (level-up B). Runs the real engines in-process to build clarity on a newly
 * added asset, then leaves it at "Ready for your review". The LLM cost ceiling is honored by the shared
 * client (it refuses calls past the monthly ceiling), so a burst of adds degrades gracefully.
 */
import { query } from "../db/pool";
import { runOnboarding, type OnboardResult, type OnboardRunners } from "../engines/onboarding";
import { runCoveragePass, type CoverageResult } from "../engines/fundamental_research";
import { runDailyMonitor } from "../engines/news_monitor";
import { runSentiment } from "../engines/sentiment";
import { runPriceMonitor } from "../engines/price_monitor";
import { runPrivateProfile } from "../engines/private_profile";
import { ClaudeFundamentalsAnalyst } from "../engines/fundamentals_analyst";
import { ClaudeNewsAnalyzer } from "../engines/analyzer";
import { PerplexityFinance, PerplexityClient } from "../sources/perplexity";
import { PriceAdapter } from "../sources/prices";
import { ClaudePriceAttributor } from "../engines/price_attribution";
import { SecAdapter } from "../sources/sec";
import { FUNDAMENTALS_CONFIG } from "../config/fundamentals";
import { DESK_CONFIG } from "../config/desk";
import { autoCommit as runAutoCommit } from "../engines/autocommit";

export interface OnboardJobData { company_id: string }

export function liveRunners(): OnboardRunners {
  const sec = new SecAdapter();
  return {
    async coverage(companyId) {
      const { rows } = await query<{ cik: string | null }>("SELECT cik FROM companies WHERE id = $1", [companyId]);
      const cik = rows[0]?.cik;
      if (!cik) throw new Error("no CIK");
      const f = await sec.recentFilings(cik, { forms: FUNDAMENTALS_CONFIG.triggerForms });
      const latest = f.data?.find((x) => /^10-[KQ]$/.test(x.form)) ?? f.data?.[0];
      if (!latest) throw new Error("no covered filing");
      // Claim the accession the same way the daily poll / webhook does, so onboard's inline coverage
      // and the poll can't both cover (and both auto-publish) the same filing. If already claimed, the
      // COVERAGE_PASS job for it will run the coverage — skip the inline pass.
      const claim = await query<{ id: string }>(
        `INSERT INTO webhook_deliveries (source, idempotency_key, company_id, payload)
         VALUES ('filing', $1, $2, $3) ON CONFLICT (source, idempotency_key) DO NOTHING RETURNING id`,
        [latest.accession, companyId, { form_type: latest.form, filing_url: latest.url, via: "onboard" }],
      );
      if (claim.rowCount === 0) return `${latest.form} ${latest.accession} · already claimed by the filing pipeline — coverage runs there`;
      let r: CoverageResult;
      try {
        r = await runCoveragePass({
          companyId, accession: latest.accession, formType: latest.form, filingUrl: latest.url,
          analyst: new ClaudeFundamentalsAnalyst(), newsAnalyzer: new ClaudeNewsAnalyzer(),
          finance: new PerplexityFinance(), perplexity: new PerplexityClient(), sec,
          deskConfig: DESK_CONFIG, trigger: "manual", autoCommit: (input) => runAutoCommit(input),
        });
      } catch (e) {
        // Release the claim so the daily poll / webhook can re-drive this accession — otherwise a
        // transient failure here would strand the filing uncovered forever.
        await query("DELETE FROM webhook_deliveries WHERE source='filing' AND idempotency_key=$1 AND (payload->>'via')='onboard'", [latest.accession]).catch(() => {});
        throw e;
      }
      return `${latest.form} ${latest.accession} · conviction ${r.conviction}/5 · confidence ${(r.confidence * 100).toFixed(0)}% · ${r.committed ? r.published_status : "in_review"}${r.deepen_rounds > 1 ? ` · ${r.deepen_rounds} rounds` : ""}`;
    },
    async monitor(companyId) {
      const r = await runDailyMonitor({ analyzer: new ClaudeNewsAnalyzer(), companyIds: [companyId] });
      return `${r.notes_created} notes · ${r.areas_opened} areas`;
    },
    async sentiment(companyId) {
      const r = await runSentiment({ companyId, trigger: "cadence" });
      return `gap ${r.gap.direction} (${r.gap.magnitude}) · conf ${(r.confidence * 100).toFixed(0)}%`;
    },
    async price(companyId) {
      const r = await runPriceMonitor({ prices: new PriceAdapter(), attributor: new ClaudePriceAttributor(), companyIds: [companyId] });
      return `${r.anomalies} anomalies`;
    },
    async profile(companyId) {
      const r = await runPrivateProfile(companyId);
      return r.ok ? "research profile built" : "profile degraded";
    },
  };
}

export async function handleOnboard(data: OnboardJobData): Promise<OnboardResult> {
  return runOnboarding({ companyId: data.company_id, runners: liveRunners() });
}
