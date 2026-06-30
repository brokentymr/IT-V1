# Phase 3 — News & Events Monitor + Read-through (record)

**Status:** ✅ complete — testing milestone green + live eval (2026-06-30).

## What was built
- **Keyless news adapter** (`lib/sources/news.ts`): Google News RSS (primary) + GDELT (best-effort,
  rate-limited), normalized + deduped, behind the isolated `SourceResult` interface. No API key.
- **LLM client + cost ledger** (`lib/llm/client.ts`, migration `0007`): structured (zod-validated)
  Claude calls; `LLM_MODEL_OVERRIDE` forces Haiku; every call records tokens + USD to `llm_usage`;
  calls are **refused once `MONTHLY_SPEND_CEILING_USD` is hit** (warns at 80%).
- **Config-not-code** (`lib/config/monitor.ts`): bands (flag ≥40, escalate ≥70), escalation window
  7d, read-through depth 2 + materiality floor, news lookback, per-company article cap.
- **Engine 3** (`lib/engines/news_monitor.ts`): per covered asset — gather → dedupe (by headline) →
  grade (0–100 rubric) → impact analysis → write primary `news_note` + provenance `source` → refresh
  `current_events.rolling_outlook` → enqueue `sentiment-run` for major items.
- **Read-through** (`lib/engines/read_through.ts`): traverse `company_links`, LLM materiality
  judgment per neighbor, write `read_through` notes, **depth-limited (2 hops) + materiality-gated**,
  cross-sector followed. Injectable analyzer (`lib/engines/analyzer.ts`) so the engine is
  deterministic in tests and real Claude is used live.
- **Daily cron**: `it-v1-monitor.timer` (09:00 UTC) → `scripts/monitor.ts` (`npm run monitor`).

## Testing milestone — 42/42 passing
- **Unit**: rubric banding; Google News RSS parsing.
- **Integration** (ephemeral Postgres + fake news + injected fake analyzer): full monitor flow
  (grade → primary notes → major escalation enqueued → read-through to the peer → rolling-outlook
  refresh → dedupe idempotency); read-through traversal over a hand-built graph asserting **depth
  limit, materiality gate, cross-sector follow, and stop-at-immaterial**.

## Live eval (real news + real Claude/Haiku) — AAPL
```
articles 8 · primary notes 8 · read-through notes 2 · cost $0.017
```
Grading was accurate (Siri-AI 62 supports; price-hike/component-cost 52–58 pressures, flagged;
index-removal/froth 15–28 neutral, logged). Read-through correctly carried Apple's component-cost
and pricing events to HP's margins/positioning, and stopped on the two immaterial items.

## DoD — met
Daily monitor on cron; `current_events` accumulates (notes + rolling outlook); read-through travels
A→B and stops when immaterial; live grading quality demonstrated; cost tracked + ceiling-guarded.

## Open items (carried forward)
- A formal **golden-set eval harness** (scored accuracy/provenance/schema vs. human-labeled set) is a
  worthwhile add; Phase 3 used the live run + deterministic tests as the gate.
- Read-through **watchlist creation** for brand-new out-of-universe assets needs news-entity
  extraction (links currently point to existing companies); deferred.
- High article counts use a fixed cap; a Haiku pre-filter/dedupe pass would scale the daily sweep
  (spec §1.2 Batch API also applies).
