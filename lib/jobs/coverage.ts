/**
 * COVERAGE_PASS job handler (Phase 4). Both ingress paths — the filing webhook and the daily
 * EDGAR poll — enqueue this job; the worker runs the Fundamental Research coverage pass with the
 * live Claude analysts (model resolved to Haiku under LLM_MODEL_OVERRIDE).
 */
import { runCoveragePass, type CoverageResult } from "../engines/fundamental_research";
import { ClaudeFundamentalsAnalyst } from "../engines/fundamentals_analyst";
import { ClaudeNewsAnalyzer } from "../engines/analyzer";
import { PerplexityFinance } from "../sources/perplexity";

export interface CoverageJobData {
  company_id: string;
  accession: string;
  form_type?: string | null;
  filing_url?: string | null;
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
    trigger: "filing",
  });
}
