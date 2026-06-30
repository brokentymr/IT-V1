/**
 * SENTIMENT_RUN job handler (Phase 7). Engine 3 enqueues this on a major event (origin + major-band
 * read-through assets); the worker runs the escalated Brand/Sentiment window with the live adapters.
 */
import { runSentiment, type SentimentResult } from "../engines/sentiment";

export interface SentimentJobData {
  company_id: string;
  window_days?: number;
  trigger_headline?: string;
}

export async function handleSentimentRun(data: SentimentJobData): Promise<SentimentResult> {
  return runSentiment({ companyId: data.company_id, windowDays: data.window_days, trigger: "escalation" });
}
