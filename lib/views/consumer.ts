/**
 * Consumer company view (level-up A). Assembles the canonical file into clean swipe CARDS — one idea
 * each — always available (computed live, no generation needed). Before approval it shows a "Building
 * clarity" state driven by the onboarding progress. The polished LLM-authored Deck (Engine 5) is a
 * separate, richer artifact reachable via a button when it exists.
 */
import { getCompanyDetail } from "./company";
import { latestOnboarding } from "../engines/onboarding";
import { consumerStatus, gapPlain } from "./status";
import { EDUCATION_BADGE, positionsLine } from "../content/disclosure";
import { BASIS_CONFIG } from "../config/fundamentals";

export interface Card { kind: string; title: string; headline: string; bullets: string[]; color: "neutral" | "bull" | "bear" | "warn" | "info"; metric: { value: string; label: string } | null }

export interface ConsumerView {
  id: string;
  ticker: string | null;
  legal_name: string;
  status: { label: string; tone: string };
  building: boolean;
  progress: Array<{ step: string; status: string; detail: string }>;
  has_deck: boolean;
  deck_id: string | null;
  cards: Card[];
  confidence: number | null; // desk confidence stamped on every published surface (compliance)
  disclosure: string;        // education/not-advice + positions + DYOR, always shown
  vetoed: boolean;           // an admin-vetoed snapshot is retracted from the swipe surface
  show_thesis: boolean;      // whether the house opinion (cards + deck link) is publishable
  snapshot_id: string | null;
}

const b = (n: number) => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : `$${(n / 1e6).toFixed(0)}M`);

export async function buildConsumerView(companyId: string): Promise<ConsumerView | null> {
  const d = await getCompanyDetail(companyId);
  if (!d) return null;
  const h = d.header;
  const status = consumerStatus(h.coverage_status);
  const onboard = await latestOnboarding(companyId);
  const building = h.coverage_status === "in_research" || (onboard?.status === "running");

  const content = (d.latest?.content ?? {}) as {
    thesis?: { one_liner?: string; tensions?: string[]; invalidation_triggers?: string[]; risks?: Array<{ title: string; severity?: string }> };
    fundamentals?: { model?: { line_items?: Record<string, { label: string; value: number; unit: string; basis?: string; yoy?: { change_pct: number } | null }> } };
    basis?: { line_item_basis?: Record<string, string> };
    scenario?: { beat_probability?: { revenue: number | null }; watch_items?: string[] };
    hypotheses?: { drivers?: Array<{ name: string; direction: string; framing: string }> };
    research?: { verification?: { confidence?: number } };
    positioning?: {
      strategic_stance?: string; variant_view?: string; is_consensus?: boolean;
      fair_value?: { base?: number | null; multiple?: number | null } | null;
      action_rules?: Array<{ trigger: string; rule: string }>;
    };
  };
  const thesis = d.approval?.edited_thesis ? { ...content.thesis, ...(d.approval.edited_thesis as object) } as typeof content.thesis : content.thesis;

  const vetoed = d.approval?.status === "vetoed";
  // The publish gate on the READ side: show house opinion only when the latest snapshot is desk/operator
  // approved OR the asset is already live (published/monitoring) — and never when vetoed. A below-bar
  // hold (in_review/watchlist, no approval) or a demoted re-coverage fails this → no opinion cards.
  const showThesis = !vetoed && (d.approval?.status === "approved" || h.coverage_status === "published" || h.coverage_status === "monitoring");
  const snapshotId = d.latest?.snapshot_id ?? null;
  const confidence = showThesis && typeof content.research?.verification?.confidence === "number" ? content.research.verification.confidence : null;
  const disclosure = [
    `${EDUCATION_BADGE} — our own research for learning, not financial advice.`,
    positionsLine(h.positions_held),
    "We may be wrong. Always do your own research.",
  ].join(" ");

  const cards: Card[] = [];
  // Header (always shown)
  cards.push({ kind: "header", title: h.primary_ticker ?? h.legal_name, headline: h.legal_name, bullets: [`${h.gics_sector ?? "—"}`, status.label], color: "info", metric: null });

  if (showThesis) {
    if (thesis?.one_liner) cards.push({ kind: "one_liner", title: "The big idea", headline: thesis.one_liner, bullets: [], color: "info", metric: null });

    const lineItemBasis = content.basis?.line_item_basis ?? {};
    // Control P11: label every reported figure with its basis so a non-GAAP number is never read as GAAP.
    const basisTag = (key: string, li: { basis?: string }): string => {
      const b = (lineItemBasis[key] ?? li.basis ?? "gaap") as keyof typeof BASIS_CONFIG.displayLabels;
      return ` (${BASIS_CONFIG.displayLabels[b] ?? b})`;
    };
    const nums = Object.entries(content.fundamentals?.model?.line_items ?? {}).slice(0, 4);
    if (nums.length) {
      const [headKey, head] = nums[0];
      cards.push({ kind: "numbers", title: "The numbers that matter", headline: `${head.label} came in at ${head.unit === "USD/shares" ? head.value.toFixed(2) : b(head.value)}${basisTag(headKey, head)}${head.yoy ? `, ${head.yoy.change_pct >= 0 ? "up" : "down"} ${Math.abs(head.yoy.change_pct * 100).toFixed(0)}% on last year` : ""}.`,
        bullets: nums.slice(1).map(([k, n]) => `${n.label}: ${n.unit === "USD/shares" ? n.value.toFixed(2) : b(n.value)}${basisTag(k, n)}${n.yoy ? ` (${n.yoy.change_pct >= 0 ? "+" : ""}${(n.yoy.change_pct * 100).toFixed(0)}% YoY)` : ""}`),
        color: "neutral", metric: { value: head.unit === "USD/shares" ? head.value.toFixed(2) : b(head.value), label: head.label } });
    }

    const drivers = (content.hypotheses?.drivers ?? []).filter((dr) => dr.direction === "tailwind");
    if (drivers.length) cards.push({ kind: "right", title: "What could go right", headline: drivers[0].framing || drivers[0].name, bullets: drivers.slice(1, 4).map((dr) => dr.name), color: "bull", metric: null });

    // Control P10: prefer the typed risks[].title when present; keep the exact tensions/invalidation_triggers
    // fallback for legacy snapshots that only carry string triggers.
    const riskTitles = (thesis?.risks ?? []).map((r) => r.title).filter(Boolean);
    if (riskTitles.length) {
      cards.push({ kind: "wrong", title: "What could go wrong", headline: riskTitles[0], bullets: riskTitles.slice(1, 4), color: "bear", metric: null });
    } else if (thesis?.tensions?.length || thesis?.invalidation_triggers?.length) {
      cards.push({ kind: "wrong", title: "What could go wrong", headline: thesis.tensions?.[0] ?? "Watch these risks", bullets: [...(thesis.tensions ?? []).slice(1, 3), ...(thesis.invalidation_triggers ?? []).slice(0, 2)], color: "bear", metric: null });
    }

    if (d.sentiment) {
      const gp = gapPlain(d.sentiment.sentiment_vs_fundamentals_gap.direction);
      cards.push({ kind: "ground_truth", title: "Ground truth", headline: gp?.text ?? "The crowd read", bullets: [d.sentiment.ground_momentum].filter(Boolean), color: gp?.tone === "warn" ? "warn" : gp?.tone === "accent" ? "info" : "bull", metric: null });
    }

    if (thesis?.invalidation_triggers?.length || h.rolling_outlook) {
      cards.push({ kind: "watching", title: "What we're watching", headline: h.rolling_outlook || thesis?.invalidation_triggers?.[0] || "The next report", bullets: (thesis?.invalidation_triggers ?? []).slice(0, 3), color: "warn", metric: null });
    }

    // Control P12: the call + an illustrative fair value (never a formal target).
    const pos = content.positioning;
    if (pos && (pos.variant_view || pos.strategic_stance)) {
      const bullets: string[] = [];
      if (pos.fair_value?.base != null) bullets.push(`Illustrative fair value ~$${pos.fair_value.base}${pos.fair_value.multiple != null ? ` (${pos.fair_value.multiple}× P50 EPS)` : ""}`);
      if (pos.action_rules?.length) bullets.push(...pos.action_rules.slice(0, 2).map((r) => `If ${r.trigger}: ${r.rule}`));
      const stanceColor = pos.strategic_stance === "strong_long" || pos.strategic_stance === "constructive" ? "bull"
        : pos.strategic_stance === "avoid" || pos.strategic_stance === "cautious" ? "bear" : "info";
      cards.push({ kind: "positioning", title: "Our call", headline: pos.variant_view || (pos.is_consensus ? "No differentiated edge — priced for the base case." : "Our read"), bullets, color: stanceColor as Card["color"], metric: null });
    }

    // Control P12: read-through relationships (who this connects to in the value chain).
    const rels = d.external_relationships ?? [];
    if (rels.length) {
      cards.push({
        kind: "relationships", title: "Who this connects to",
        headline: `${rels.length} ${rels.length === 1 ? "company" : "companies"} in the value chain`,
        bullets: rels.slice(0, 4).map((r) => `${r.counterparty_name}${r.type ? ` (${r.type})` : ""}${r.read_through ? ` — ${r.read_through}` : ""}`),
        color: "info", metric: null,
      });
    }
  }

  const view = {
    id: h.id, ticker: h.primary_ticker, legal_name: h.legal_name, status, building,
    progress: (onboard?.steps ?? []).map((s) => ({ step: s.step, status: s.status, detail: s.detail })),
    has_deck: false, deck_id: null, // resolved by the page (needs content_items)
    confidence, disclosure, vetoed, show_thesis: showThesis, snapshot_id: snapshotId,
  };

  // No approved thesis for the latest snapshot → show identity + a plain-status card only, never the
  // AI opinion. `building` = still onboarding; vetoed = retracted; otherwise a below-bar/under-review hold.
  if (!showThesis) {
    const headline = vetoed
      ? "We're re-checking this research and it isn't shown right now."
      : building
        ? "We're building clarity on this company — check back shortly."
        : "This research is still being finalized and isn't shown yet.";
    return {
      ...view,
      cards: [cards[0], { kind: "under_review", title: vetoed ? "Under review" : building ? "Building clarity" : "In review", headline, bullets: [], color: "warn" as const, metric: null }],
    };
  }

  return { ...view, cards };
}
