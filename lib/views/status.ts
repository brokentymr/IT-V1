/**
 * Human status vocabulary (level-up A). The consumer surface never shows operator jargon
 * (watchlist / in_research / in_review); it shows what's happening in plain words.
 */
export interface ConsumerStatus { label: string; tone: "neutral" | "info" | "warn" | "good" | "accent" }

export function consumerStatus(coverageStatus: string): ConsumerStatus {
  switch (coverageStatus) {
    case "watchlist": return { label: "Queued", tone: "neutral" };
    case "queued": return { label: "Queued", tone: "neutral" };
    case "in_research": return { label: "Building clarity", tone: "info" };
    case "in_review": return { label: "Ready for your review", tone: "warn" };
    case "monitoring": return { label: "Live", tone: "good" };
    case "published": return { label: "Published", tone: "accent" };
    default: return { label: coverageStatus, tone: "neutral" };
  }
}

/** The crowd-vs-fundamentals gap, in plain words for a card. */
export function gapPlain(direction?: string | null): { text: string; tone: "warn" | "accent" | "good" | "neutral" } | null {
  if (!direction) return null;
  if (direction === "sentiment_ahead") return { text: "Crowd's hotter than the numbers", tone: "warn" };
  if (direction === "sentiment_behind") return { text: "Crowd's cooler than the numbers", tone: "accent" };
  if (direction === "aligned") return { text: "Crowd and numbers agree", tone: "good" };
  return null;
}
