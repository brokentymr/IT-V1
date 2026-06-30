import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseGoogleNews } from "./news";

const fixture = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures/news/google-news-apple.xml"),
  "utf8",
);

describe("Google News RSS parsing", () => {
  it("parses articles with title / url / source / date", () => {
    const articles = parseGoogleNews(fixture);
    expect(articles.length).toBeGreaterThan(50);
    const a = articles[0];
    expect(a.title.length).toBeGreaterThan(0);
    expect(a.url).toContain("news.google.com");
    expect(a.provider).toBe("google_news");
    expect(a.published_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("strips the ' - Source' suffix from titles", () => {
    const articles = parseGoogleNews(fixture);
    for (const a of articles.slice(0, 20)) {
      if (a.source) expect(a.title.endsWith(` - ${a.source}`)).toBe(false);
    }
  });
});
