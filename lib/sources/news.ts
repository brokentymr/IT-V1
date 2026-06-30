/**
 * Keyless news adapter (Engine 3 input). Free sources, no API key:
 *   - Google News RSS  (primary)  https://news.google.com/rss/search?q=...
 *   - GDELT DOC API    (secondary, best-effort; rate-limited to 1 req / 5s)
 *
 * Behind the isolated SourceResult interface (spec §8): a dead/limited source degrades
 * (missing[] note) rather than failing the cycle. Injectable fetcher for fixture-based tests.
 */
import { XMLParser } from "fast-xml-parser";
import type { ProvenanceStamp, SourceResult, TextFetcher } from "./types";

export interface NewsArticle {
  title: string;
  url: string;
  source: string | null; // publisher
  published_at: string | null; // ISO
  snippet: string | null;
  provider: "google_news" | "gdelt";
}

/** Injectable news source (NewsAdapter in production; a fake in tests). */
export interface NewsSource {
  fetchCompanyNews(opts: {
    legalName: string;
    tickers: string[];
    sinceDays?: number;
  }): Promise<SourceResult<NewsArticle[]>>;
}

const USER_AGENT = "investing-together/0.1 (brokentymr@gmail.com)";

export const liveTextFetcher: TextFetcher = async (url, headers = {}) => {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, ...headers } });
  return { status: res.status, text: res.status === 200 ? await res.text() : "" };
};

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function stripSourceSuffix(title: string, source: string | null): string {
  if (source && title.endsWith(` - ${source}`)) return title.slice(0, -(source.length + 3)).trim();
  return title.trim();
}

function toIso(d: string | undefined): string | null {
  if (!d) return null;
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

export function parseGoogleNews(rss: string): NewsArticle[] {
  const parsed = xml.parse(rss);
  const items = parsed?.rss?.channel?.item;
  const list = Array.isArray(items) ? items : items ? [items] : [];
  return list.map((it: Record<string, unknown>): NewsArticle => {
    const src = it.source as { "#text"?: string } | string | undefined;
    const source = typeof src === "object" ? (src["#text"] ?? null) : typeof src === "string" ? src : null;
    const rawTitle = String(it.title ?? "");
    return {
      title: stripSourceSuffix(rawTitle, source),
      url: String(it.link ?? ""),
      source,
      published_at: toIso(it.pubDate as string | undefined),
      snippet: typeof it.description === "string" ? it.description.replace(/<[^>]+>/g, "").trim() || null : null,
      provider: "google_news",
    };
  }).filter((a) => a.title && a.url);
}

function parseGdelt(jsonText: string): NewsArticle[] {
  try {
    const j = JSON.parse(jsonText) as { articles?: Array<Record<string, string>> };
    return (j.articles ?? []).map((a): NewsArticle => ({
      title: (a.title ?? "").trim(),
      url: a.url ?? "",
      source: a.domain ?? null,
      published_at: a.seendate ? toIso(a.seendate.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, "$1-$2-$3T$4:$5:$6Z")) : null,
      snippet: null,
      provider: "gdelt",
    })).filter((a) => a.title && a.url);
  } catch {
    return []; // rate-limit message or malformed → degrade
  }
}

function dedupe(articles: NewsArticle[]): NewsArticle[] {
  const seen = new Set<string>();
  const out: NewsArticle[] = [];
  for (const a of articles) {
    const key = a.title.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

export class NewsAdapter implements NewsSource {
  constructor(private readonly fetchText: TextFetcher = liveTextFetcher) {}

  /** Build a recency-bounded query from the company's name + tickers. */
  private query(legalName: string, tickers: string[]): string {
    const terms = [legalName, ...tickers].filter(Boolean);
    return terms.map((t) => (t.includes(" ") ? `"${t}"` : t)).join(" OR ");
  }

  async fetchCompanyNews(opts: {
    legalName: string;
    tickers: string[];
    sinceDays?: number;
  }): Promise<SourceResult<NewsArticle[]>> {
    const sinceDays = opts.sinceDays ?? 2;
    const q = this.query(opts.legalName, opts.tickers);
    const missing: string[] = [];
    const articles: NewsArticle[] = [];

    // Primary: Google News RSS
    const gnUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:${sinceDays}d`)}&hl=en-US&gl=US&ceid=US:en`;
    const stamp: ProvenanceStamp = { origin: "Google News", url: gnUrl, retrieved_at: new Date().toISOString() };
    try {
      const { status, text } = await this.fetchText(gnUrl);
      if (status === 200 && text) articles.push(...parseGoogleNews(text));
      else missing.push(`Google News (HTTP ${status})`);
    } catch (err) {
      missing.push(`Google News unreachable: ${(err as Error).message}`);
    }

    // Secondary (best-effort): GDELT
    const gdUrl = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`"${opts.legalName}"`)}&mode=ArtList&format=json&maxrecords=25&timespan=${sinceDays}d&sort=DateDesc`;
    try {
      const { status, text } = await this.fetchText(gdUrl);
      if (status === 200 && text) articles.push(...parseGdelt(text));
    } catch {
      missing.push("GDELT unavailable (best-effort)");
    }

    const deduped = dedupe(articles);
    return {
      ok: deduped.length > 0 || missing.length === 0,
      data: deduped,
      missing,
      provenance: stamp,
    };
  }
}
