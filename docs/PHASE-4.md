# Phase 4 — Fundamental Research engine (Engine 2) (record)

**Status:** ✅ complete — testing milestone green + live eval on AAPL (2026-06-30).

## Decisions locked with the owner (2026-06-30)
- **Data:** free/keyless **SEC EDGAR** (filings + XBRL company facts). No paid sources.
- **Transcripts:** deferred (filing-only); the analyst surface leaves a slot for them later.
- **Filing arrival:** EDGAR has no push webhook → a **daily poll** detects new filings and enqueues
  the existing `coverage-pass` job. The Phase-2 filing webhook still works; both dedupe on the same
  key so a filing seen by both is processed once.
- **Earnings date:** **Nasdaq** keyless endpoint → **cadence estimate** from EDGAR history →
  **manual override** (`companies.next_earnings_date`). Precedence in that order.
- **Model math:** computed **deterministically in TypeScript** from XBRL — no LLM in the number
  path (reproducible, Haiku-safe). The LLM only frames the forward view and narrates the thesis.

## What was built
- **EDGAR adapter** (`lib/sources/sec.ts`): added `recentFilings`, `companyFacts` (XBRL), and
  `fetchFilingDocument`; live fetchers now carry a **15s timeout** so a blocking host degrades
  (spec §8) instead of hanging the pass.
- **Earnings-date discovery** (`lib/sources/earnings.ts`): `NasdaqEarningsAdapter` (defensive JSON
  walk for a future date) + deterministic `estimateFromCadence` + `resolveNextEarningsDate`.
- **Deterministic model** (`lib/financials/model.ts`): `extractStatements` (grounded to the filing's
  XBRL `accn`, so every line item carries the accession that reported it), `buildModel` (margins +
  YoY), `diffModels` (the first-class snapshot diff). Config in `lib/config/fundamentals.ts`
  (trigger forms, forward lead days, XBRL concept fallbacks).
- **Engine 2** (`lib/engines/fundamental_research.ts`):
  - **Forward pass** — resolve next date, pre-warm the standing model, frame expectations +
    confirm/break conditions → `current_events.forward_note`.
  - **Coverage pass** — extract (grounded) → refresh model → diff vs prior snapshot → draft thesis
    (actual-vs-expected, tensions, **specific invalidation triggers**) → **append snapshot + diff**
    (append-only) → enrich links from filing text (grounded, links only to known companies) → run
    read-through so the filing propagates to linked assets.
- **Injectable analyst** (`lib/engines/fundamentals_analyst.ts`): `frameForward` / `draftThesis` /
  `extractLinks` — fake in tests, real Claude (Haiku under `LLM_MODEL_OVERRIDE`) live.
- **Wiring**: `COVERAGE_PASS` worker handler (`lib/jobs/coverage.ts`); daily **EDGAR poll**
  (`lib/engines/filing_poll.ts`, `scripts/poll-filings.ts`, `it-v1-filings.timer` @ 11:00 UTC);
  CLIs `npm run fundamentals -- <TICKER> --forward|--coverage` and `npm run poll-filings`;
  migration `0008` (snapshot `diff` column).

## Testing milestone — 50/50 passing
- **Unit** (`lib/financials/model.test.ts`): accession-grounded extraction + latest-by-end fallback,
  derived margins, YoY, and the snapshot diff (direction/pct, new/flat).
- **Integration** (`tests/fundamentals.integration.test.ts`, ephemeral Postgres + fake SEC + fake
  analyst): coverage pass produces a grounded, schema-valid snapshot with thesis + diff; link
  enrichment creates a new link from filing text; read-through reaches the material neighbor only;
  **append-only verified** (a re-run appends a 2nd snapshot, the 1st is byte-identical, the 2nd diff
  is computed vs the 1st); forward pass stages a forward note + resolves a cadence date.
- Fixed a pre-existing parallel-teardown flake in `tests/helpers/ephemeral-db.ts` (replaced
  `DROP … WITH (FORCE)`, which a non-superuser can't fully signal, with a self-owned terminate +
  retrying plain DROP).

## Live eval (real EDGAR + real Claude/Haiku) — AAPL `eval:fundamentals`
Scored the coverage pass on AAPL's real **10-Q `0000320193-26-000013`** (Q2 2026):
```
[PASS] statement extraction: 11 line items; revenue=111,184,000,000 net_income=29,578,000,000; missing=[]
[PASS] provenance coverage: 11/11 claims carry a source_ref; all line items accession-tagged
[PASS] schema conformance: thesis=ok fundamentals=ok
[PASS] invalidation triggers: 4/4 specific (e.g. "Gross margin remains >48.5% for two quarters…",
        "Revenue growth decelerates to <8% YoY in Q3 2026…", "chip substitution costs <$500M…")
Score: 4/4 | diff metrics 11 | read-through 1 | cost $0.0103
```
Forward pass (`--forward`) staged a forward note with eight focus metrics for $0.0044; the blocking
Nasdaq host degraded to the cadence estimate as designed.

## Perplexity factual layer (added 2026-06-30, bundled into this phase)
Owner provided a Perplexity API key. Perplexity Finance is **Fiscal.ai-backed**, so one keyed source
covers what we'd otherwise pull from Fiscal.ai **and** Morningstar (no separate keys needed).
- **`lib/sources/perplexity.ts`**: `PerplexityClient` (Sonar; `askText`/`askJSON`; cost taken from
  the API's own `usage.cost.total_cost` and stamped into `llm_usage`; ceiling-guarded; 20s timeout;
  degrades on failure). `PerplexityFinance` adapter: `nextEarningsDate`, `consensus`, `analystView`
  (fair value / rating / economic moat — the Morningstar-style data).
- **Wired (advisory only — never the modeled-number path):** primary **earnings-date tier** in
  `resolveNextEarningsDate` (manual override → Perplexity → Nasdaq → cadence); **consensus + analyst
  view** fed into `frameForward` and `draftThesis`; stored as a provenance-stamped
  `content.market_context` block, kept distinct from the XBRL `fundamentals`.
- **Date-lookup nuance:** under a strict "JSON only" instruction Sonar suppresses its calendar
  search and returns null, so `nextEarningsDate` uses a **text** ask + date extraction (the JSON
  path is kept for the structured consensus/analyst calls).
- **Manual-vs-auto date fix:** the manual tier now reads an explicit
  `coverage.next_earnings_date_override` (owner-set), so a previously auto-resolved estimate no
  longer masks re-resolution.
- **Live:** forward pass resolved AAPL's next date via Perplexity (`2026-07-30`); a coverage snapshot
  stored consensus (EPS $1.88 / rev $108.9B / last quarter "Beat") + Morningstar fair value $270,
  wide moat. Eval stayed 4/4 with triggers now citing consensus levels. 53/53 tests pass.

## MD&A hypotheses + Monte Carlo scenario (improvements #3 + #4, added 2026-06-30)
The coverage pass now also turns the filing's narrative into a probabilistic forward view.
- **#3 drivers** (`lib/financials/filing_text.ts` + analyst `extractDrivers`): slice the MD&A
  (10-K Item 7 / 10-Q Item 2) from the filing we already fetch, extract 3-6 grounded **drivers**,
  each mapped to a tracked metric with a bear/base/bull % impact + a quote. Stored as a
  provenance-stamped `content.hypotheses` block and carried into `current_events.hypotheses`.
- **#4 Monte Carlo** (`lib/financials/montecarlo.ts`, pure TS, seeded RNG): sample ~10k runs over
  the driver ranges (triangular) **bounded by the metric's own historical volatility** (hybrid,
  owner decision) + historical-variance noise → P10/P50/P90 for next-period revenue / net income /
  EPS, a **beat-probability vs the Perplexity consensus**, an analytic **sensitivity ranking**, and
  measurable **watch-items**. Stored as `content.scenario`.
- **XBRL duration trap fixed:** the volatility/base series filter to consistent ~3-month periods
  (a concept tags 3/6/9-month + annual values under one unit; mixing them produced nonsense growth).
- **Live (AAPL Q2-2026 10-Q):** 6 drivers; median revenue **$108.8B vs $108.9B consensus**, EPS
  median $1.91 vs $1.88 (53% beat-prob), net margin P10-P90 22-30%; top driver (Product revenue) =
  80% of outcome variance. Pure-TS sim is free; the one MD&A call ran under Haiku (~$0.036 total run).

## DoD — met
Forward + coverage passes run; a real filing produces a **sourced, schema-valid snapshot with a
thesis and a diff**; links get enriched from the filing; read-through propagates; append-only holds;
external factual context (Perplexity/Fiscal.ai) flows in as advisory, provenance-stamped market
context; MD&A drivers + a Monte Carlo next-period scenario (bands, beat-prob, sensitivity,
watch-items) are produced and stored; cost tracked + ceiling-guarded (month spend ~$0.23, all engines).

## Open items (carried forward)
- **Transcripts** deferred until a source is available (filing-only today).
- **Nasdaq earnings endpoint** blocks plain (non-browser) requests, so the date resolver usually
  falls back to the cadence estimate; a manual override or browser-style headers would firm it up.
- companyfacts can **lag minutes** behind a just-filed report; extraction falls back to latest-by-end
  when the accession isn't yet present — re-running once facts post fixes it (append-only, safe).
- Link enrichment reads a bounded concentration excerpt and links only to **already-covered**
  companies; out-of-universe counterparties need ingestion (as in Phase 3).
