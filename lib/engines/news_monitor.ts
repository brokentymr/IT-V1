/**
 * Engine 3 — News & Events Monitor (spec §4.3). The daily pulse: per covered asset, gather news,
 * dedupe, grade importance (0–100 rubric), run impact analysis, write a primary news_note with
 * provenance, refresh the rolling outlook, run the read-through pass for material items, and
 * enqueue a Brand/Sentiment escalation for major items.
 */
import { randomUUID } from "node:crypto";
import { query, withTransaction } from "../db/pool";
import { NewsAdapter, type NewsArticle, type NewsSource } from "../sources/news";
import { NewsNote } from "../types";
import { MONITOR_CONFIG, bandFor, statusFor } from "../config/monitor";
import { JOB, type Queue } from "../queue/types";
import { bossQueue } from "../queue/boss";
import type { NewsAnalyzer } from "./analyzer";
import { propagateReadThrough } from "./read_through";

const MONITORED_STATUSES = ["in_research", "in_review", "published", "monitoring"];

export interface MonitorResult {
  companies: number;
  articles_seen: number;
  notes_created: number;
  read_through_notes: number;
  escalations: number;
  skipped_duplicates: number;
}

interface CompanyRow {
  id: string;
  legal_name: string;
  primary_ticker: string;
  gics_sector: string | null;
}

export async function runDailyMonitor(opts: {
  analyzer: NewsAnalyzer;
  news?: NewsSource;
  queue?: Queue;
  companyIds?: string[];
  sinceDays?: number;
  maxArticles?: number;
}): Promise<MonitorResult> {
  const news = opts.news ?? new NewsAdapter();
  const queue = opts.queue ?? bossQueue;
  const sinceDays = opts.sinceDays ?? MONITOR_CONFIG.newsSinceDays;
  const maxArticles = opts.maxArticles ?? MONITOR_CONFIG.maxArticlesPerCompany;
  const result: MonitorResult = {
    companies: 0, articles_seen: 0, notes_created: 0, read_through_notes: 0, escalations: 0, skipped_duplicates: 0,
  };

  const companies = await query<CompanyRow>(
    opts.companyIds?.length
      ? "SELECT id, legal_name, primary_ticker, gics_sector FROM companies WHERE id = ANY($1)"
      : "SELECT id, legal_name, primary_ticker, gics_sector FROM companies WHERE coverage_status = ANY($1)",
    [opts.companyIds?.length ? opts.companyIds : MONITORED_STATUSES],
  );

  for (const company of companies.rows) {
    result.companies++;

    const cf = await query<{ current_events: { rolling_outlook?: string } }>(
      "SELECT current_events FROM canonical_files WHERE company_id = $1",
      [company.id],
    );
    const rollingOutlook = cf.rows[0]?.current_events?.rolling_outlook ?? "";

    const newsRes = await news.fetchCompanyNews({
      legalName: company.legal_name, tickers: [company.primary_ticker], sinceDays,
    });
    const articles = (newsRes.data ?? []).slice(0, maxArticles);
    result.articles_seen += articles.length;

    // dedupe against recent existing notes by headline
    const existing = await query<{ h: string | null }>(
      "SELECT content->>'headline' AS h FROM news_notes WHERE company_id = $1 AND detected_at > now() - interval '14 days'",
      [company.id],
    );
    const seen = new Set(existing.rows.map((r) => (r.h ?? "").toLowerCase()));

    let topOutlook: { score: number; outlook: string } | null = null;

    for (const article of articles) {
      const key = article.title.toLowerCase();
      if (seen.has(key)) { result.skipped_duplicates++; continue; }
      seen.add(key);

      const a = await opts.analyzer.analyze({
        company: {
          legal_name: company.legal_name, ticker: company.primary_ticker,
          gics_sector: company.gics_sector, rolling_outlook: rollingOutlook,
        },
        article: {
          title: article.title, snippet: article.snippet,
          source: article.source, published_at: article.published_at,
        },
      });

      const band = bandFor(a.importance_score);
      const status = statusFor(a.importance_score);

      const { noteId, sourceId } = await writePrimaryNote(company, article, a, status);
      result.notes_created++;

      if (band !== "low") {
        if (!topOutlook || a.importance_score > topOutlook.score) {
          topOutlook = { score: a.importance_score, outlook: a.impact.forward_outlook };
        }
        const rt = await propagateReadThrough(opts.analyzer, {
          noteId, companyId: company.id, companyName: company.legal_name,
          headline: article.title, summary: a.impact.forward_outlook, category: a.category, sourceRef: sourceId,
        });
        result.read_through_notes += rt.notesCreated;
      }

      if (band === "major") {
        await queue.enqueue(JOB.SENTIMENT_RUN, {
          company_id: company.id, window_days: MONITOR_CONFIG.escalationWindowDays, trigger_headline: article.title,
        }).catch((e) => console.warn("[monitor] escalation enqueue failed:", (e as Error).message));
        result.escalations++;
      }
    }

    // refresh rolling outlook + last_monitored
    await query(
      `UPDATE canonical_files
          SET current_events = jsonb_set(
                jsonb_set(current_events, '{last_monitored}', to_jsonb(now()::text)),
                '{rolling_outlook}', to_jsonb($2::text))
        WHERE company_id = $1`,
      [company.id, topOutlook?.outlook ?? rollingOutlook],
    );
  }

  return result;
}

async function writePrimaryNote(
  company: CompanyRow,
  article: NewsArticle,
  a: Awaited<ReturnType<NewsAnalyzer["analyze"]>>,
  status: string,
): Promise<{ noteId: string; sourceId: string }> {
  return withTransaction(async (client) => {
    const src = await client.query<{ id: string }>(
      `INSERT INTO sources (company_id, tier, kind, origin, url, title, retrieved_at, metadata)
       VALUES ($1, 1, 'news', $2, $3, $4, now(), $5) RETURNING id`,
      [company.id, article.source ?? "Google News", article.url, article.title,
        { provider: article.provider, published_at: article.published_at }],
    );
    const sourceId = src.rows[0].id;
    const noteId = randomUUID();
    const content = NewsNote.parse({
      id: noteId, company_id: company.id, detected_at: new Date().toISOString(), source_ref: sourceId,
      headline: article.title, summary: article.snippet ?? article.title, category: a.category,
      origin: { kind: "primary", origin_event_ref: null, origin_company_id: null, link_type: null },
      importance_score: a.importance_score, importance_rationale: a.importance_rationale,
      impact_analysis: {
        forward_outlook: a.impact.forward_outlook, thesis_effect: a.impact.thesis_effect,
        invalidation_trigger_hit: null, sentiment_effect: a.impact.sentiment_effect,
        estimated_magnitude: a.impact.estimated_magnitude,
      },
      read_through: [], status: status as "logged" | "flagged" | "escalated",
    });
    await client.query(
      `INSERT INTO news_notes (id, company_id, detected_at, source_ref, category, origin_kind, origin_company_id, importance_score, status, content)
       VALUES ($1, $2, now(), $3, $4, 'primary', null, $5, $6, $7)`,
      [noteId, company.id, sourceId, a.category, a.importance_score, status, content],
    );
    return { noteId, sourceId };
  });
}
