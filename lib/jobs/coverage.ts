/**
 * COVERAGE_PASS job handler (Phase 4 + Workstream C). Both ingress paths — the filing webhook and the
 * daily EDGAR poll — enqueue this job; the worker runs the Fundamental Research coverage pass with the
 * live Claude analysts, the deepening loop, and auto-commit (publish + enqueue content when the desk
 * clears the confidence bar). The "Deepen research now" chat button re-enters here with a focus override.
 */
import { runCoveragePass, type CoverageResult } from "../engines/fundamental_research";
import { ClaudeFundamentalsAnalyst } from "../engines/fundamentals_analyst";
import { ClaudeNewsAnalyzer } from "../engines/analyzer";
import { PerplexityFinance, PerplexityClient } from "../sources/perplexity";
import { DESK_CONFIG } from "../config/desk";
import { autoCommit as runAutoCommit } from "../engines/autocommit";

export interface CoverageJobData {
  company_id: string;
  accession: string;
  form_type?: string | null;
  filing_url?: string | null;
  focus_override?: string[]; // set by the chat "Deepen research now" trigger
}

export async function handleCoveragePass(data: CoverageJobData): Promise<CoverageResult> {
  return runCoveragePass({
    companyId: data.company_id,
    accession: data.accession,
    formType: data.form_type ?? null,
    filingUrl: data.filing_url ?? null,
    analyst: new ClaudeFundamentalsAnalyst(),
    newsAnalyzer: new ClaudeNewsAnalyzer(),
    finance: new PerplexityFinance(),
    perplexity: new PerplexityClient(),
    deskConfig: DESK_CONFIG,
    focusOverride: data.focus_override,
    trigger: "filing",
    autoCommit: (input) => runAutoCommit(input),
  });
}
