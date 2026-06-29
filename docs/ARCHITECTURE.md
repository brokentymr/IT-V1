# Investing Together — System Architecture & Build Specification

An agentic research-and-content platform built on an owned, proprietary knowledge base. Raw materials flow in, are processed into proprietary reports and outputs, and are rendered for an everyday, family-friendly investing audience.

> This document is the authoritative contract for **what** we build. The data-model schemas (§3) and consumable structures (§6) are normative — agents and the application read and write to these shapes exactly. For **how and in what order** to build, see `BUILD-PLAN.md`. For the working method, see the repo-root `CLAUDE.md`.

---

## 1. Principles

**One substrate, many adapters.** Research is performed once per company per cycle and stored in a canonical, versioned object. Every output — company memo, sector report, podcast script, short-form pack, newsletter — is a transformation of that object. No output performs its own research.

**The knowledge base is the proprietary core.** It is owned, runs on owned infrastructure, and is where raw filings, research materials, news, and market signals are refined into proprietary outputs. The asset of the business is this database and what it produces.

**Storage is a faceted graph; navigation is a hierarchy.** The company is the atomic node; sector and market are facets, and companies are linked to one another by typed relationship edges (section 3.8). "Sectors → Markets → Companies" is one navigation view, not the storage shape — which is what allows a cohort to span markets and impact to travel across asset links.

**Coverage is relational, not isolated.** We do not cover an asset in a vacuum. Each covered asset's coverage includes its direct exposures (suppliers, customers, competitors, parents/subsidiaries) and its material indirect exposures (sector peers, shared end-markets, macro and thematic links). When something happens to one asset, the system assesses and records the read-through to the others it is connected to — in-sector or out — because that read-through is often where the opportunity or the risk actually lives.

**The audience is everyday people exploring value together.** Content is family-friendly and approachable, never gated to experts or high-net-worth readers. The knowledge base holds institutional-grade rigor; outputs translate that rigor into plain, welcoming language.

**The cadence is a fluid loop anchored on known filing dates.** There is no fixed quarterly clock and no purely reactive waiting. The next earnings/filing date is known, so the system runs a forward-looking pass as that date approaches (framing what to expect and what would confirm or break the thesis), then ingests the actual filing the moment it lands and turns it into coverage fast — measuring actual against the forward view it already staged. Between filings, a steady daily pulse monitors news and events. Event-driven triggers (filings, material events with their read-through, market signals) drive the rest.

---

## 2. Knowledge Base — owned, proprietary, three tiers

```
TIER 1 — RAW LANDING ZONE   (immutable, as-received, provenance-stamped)
  Raw filings        10-K / 10-Q / 8-K / S-1 / proxies / transcripts
  Research materials uploaded PDFs, notes, third-party research
  News               articles, wire items, press releases
  Pricing            OHLCV history, quotes
  TradingView alerts pricing + indicator alerts via webhook (FAE, CHoCH/BOS,
                     AVWAP, RSI bands, etc.)
        |
        v
TIER 2 — PROCESSING   (the agent mesh, section 4)
  extract . normalize . model . grade . score . synthesize
        |
        v
TIER 3 — PROPRIETARY OUTPUTS   (the consumables, section 6)
  Canonical company files (versioned)
  Sector cohort files
  News notes (rolling current-events context)
  Content artifacts (memo, report, script, short-form, newsletter)
```

Blobs (raw PDFs/HTML, audio) are stored in object storage; structured data and all processed outputs are stored in Postgres. Every raw item is provenance-stamped on arrival; every downstream claim links back to a Tier-1 source.

---

## 3. Data Model — entities and schemas

These schemas are authoritative. Agents and the application read and write to these shapes exactly.

### 3.1 Sector taxonomy (GICS)

`Sector (11) → Industry Group (25) → Industry (74) → Sub-Industry (163)`. Stored as the full path on every company. Sub-Industry is the cohort unit; Sector is the unit for sector-level pieces.

### 3.2 Market

```yaml
market:
  exchange: string          # NYSE, NASDAQ, LSE, TSE, HKEX
  country: string           # US, UK, JP
  region: enum              # NA | EMEA | APAC | LATAM
  currency: string          # USD, GBP, JPY
  calendar_ref: id          # exchange + earnings calendar
  primary_filing_system: enum   # SEC_EDGAR | UK_NSM | EDINET | ...
```

### 3.3 Company index record

```yaml
company:
  id: uuid
  identifiers: { legal_name, tickers: [string], isin, cik, lei }
  classification: { gics_sector, industry_group, industry, sub_industry }
  markets: [ market ]
  tradingview_symbol: string       # e.g. "NYSE:REF" — for alert routing
  coverage:
    status: enum                   # watchlist | queued | in_research | in_review | published | monitoring
    authors: [string]              # attribution metadata only
    next_earnings_date: date
    positions_held: [ {instrument, direction, size, as_of} ]
  canonical_file_ref: uuid
  content_refs: [uuid]
```

### 3.4 Canonical Company File

Time-versioned. Each cycle appends a snapshot; the diff between snapshots is a first-class asset. `current_events` is maintained daily between snapshots and carried forward as context.

```yaml
canonical_file:
  company_id: uuid
  current_events:                          # maintained DAILY (section 4.3); rolls forward
    rolling_outlook: string                # the maintained forward view, updated by material news
    last_monitored: timestamp
    notes: [ news_note ]                   # see 3.6
  snapshots:
    - snapshot_id: uuid
      as_of: date
      cycle_label: string                  # e.g. "post-10Q-2026Q2"
      trigger: enum                        # filing | manual
      filing_ref: id                       # the filing that triggered this snapshot

      fundamentals:                                  # ENGINE: Fundamental Research
        statements: { income_statement, balance_sheet, cash_flow, segments }
        capital_structure: { debt: [ {instrument, amount, rate, maturity} ], net_debt, leverage_x, governance_flags: [string] }
        model:
          normalized_metrics: { ebitda, fcf, margins, growth }
          scenarios: { bear: {ev, equity, per_share}, base: {...}, bull: {...} }
          valuation_conclusion: { entry_x, fair_x, target_equity }
          drivers: { ... }                 # model-specific (e.g. margin bridge, halo engine)
        provenance: [ {claim_id, source_ref} ]

      brand_sentiment:                               # ENGINE: Brand/Sentiment
        by_platform: [ {platform, volume, sentiment, trend, top_themes} ]
        ground_momentum: string
        sentiment_vs_fundamentals_gap: { direction, magnitude }
        coverage_window: { from, to }       # set wider during event escalation (4.3)
        provenance: [ {claim_id, source_ref} ]

      signals:                                       # ENGINE: Signal ingest
        pricing: { last, range_52w, perf, valuation_vs_price_overlay }
        tradingview_alerts: [ {ts, indicator, signal, timeframe, price, note} ]
        technical_context: string           # price relative to thesis entry/fair/target

      thesis:                                        # synthesis of all engines
        one_liner: string
        long_form: string
        tensions: [string]
        catalysts: [ {event, date, expected_impact} ]
        invalidation_triggers: [string]
        conviction: int                     # 1-5
        positions_held: { ... }             # inherited -> flows to every output

      events:
        earnings: [ {date, period, status} ]
        filings:  [ {type, date, url, ref} ]
```

### 3.5 Sector Cohort File

```yaml
cohort_file:
  scope: { gics_level: enum, value: string, markets: [enum] }
  as_of: date
  constituents: [company_id]
  comparative: { valuation_table, margin_structure, growth_table, sentiment_table }
  positioning: { leaders: [company_id], laggards: [company_id], value_opportunity: string, divergences: [string] }
  sector_thesis: { strengths: [string], weaknesses: [string], where_the_opportunity_is: string }
  provenance: [ {claim_id, source_ref} ]
```

### 3.6 News Note (rolling current-events record)

```yaml
news_note:
  id: uuid
  company_id: uuid                          # the asset this note is ABOUT
  detected_at: timestamp
  source_ref: id                            # provenance to Tier 1
  headline: string
  summary: string                           # plain language
  category: enum    # guidance | product | management | legal_regulatory | macro | m_and_a | capital_markets | other
  origin:                                   # how this note came to exist
    kind: enum                              # primary | read_through
    origin_event_ref: id|null               # if read_through: the originating note on another asset
    origin_company_id: uuid|null            # if read_through: the asset the event happened to
    link_type: enum|null                    # the relationship edge it traveled (3.8)
  importance_score: int                     # 0-100, rubric in 4.3
  importance_rationale: string
  impact_analysis:
    forward_outlook: string                 # how it changes the forward view
    thesis_effect: enum                     # supports | pressures | neutral | invalidates
    invalidation_trigger_hit: string|null   # which trigger, if any
    sentiment_effect: string
    estimated_magnitude: enum               # low | medium | high
  read_through: [ {affected_company_id, link_type, expected_effect, materiality} ]  # outbound read-throughs raised from this note
  status: enum                              # logged | flagged | escalated
  escalation: { triggered: bool, type: "sentiment_run", window_days: int, job_ref: id|null }
  carried_into: snapshot_id|null            # context handed to the next full cycle
```

### 3.7 Raw document and Signal records

```yaml
raw_document:
  id: uuid
  company_id: uuid
  kind: enum            # filing | transcript | research | news | other
  received_at: timestamp
  source: string
  blob_ref: string      # object storage key
  metadata: { ... }

signal_event:
  id: uuid
  company_id: uuid
  ts: timestamp
  kind: enum            # price | tradingview_alert
  payload: { ... }      # raw alert JSON for TradingView
```

### 3.8 Company relationship (link)

The edges that make coverage relational. A directed, typed link from one company to another, in-sector or cross-sector. Links are seeded by the Ingestion agent, enriched by Fundamental Research (which reads suppliers, customers, and concentrations out of filings), and curated by hand. They are what read-through analysis (4.3, 4.6) traverses.

```yaml
company_link:
  id: uuid
  from_company_id: uuid                 # the source asset
  to_company_id: uuid                   # the asset that may be affected
  type: enum   # competitor | supplier | customer | parent | subsidiary | jv_partner |
               # shared_end_market | thematic_peer | macro_correlated
  cross_sector: bool                    # true if the two sit in different GICS sectors
  strength: enum                        # weak | medium | strong
  direction_note: string                # how impact tends to flow (e.g. "input cost: A up -> B margin down")
  rationale: string
  source_ref: id                        # provenance
  status: enum                          # active | stale | unverified
```

A linked company that is material but not yet in the universe is created as a `watchlist` company so the link can exist and the read-through can be recorded (see 4.6).

---

## 4. Agent System

Eight engines. Single responsibility each, coordinated by the orchestrator (no agent calls another directly), each writing a defined consumable.

### 4.1 Roster

| # | Engine | Trigger | Reads | Writes | Tools |
|---|---|---|---|---|---|
| 1 | Ingestion / Identity | add company | a ticker | company record + canonical skeleton | FMP, S&P Global, SEC, web |
| 2 | Fundamental Research | **forward pass** as filing date nears + **coverage pass** on filing arrival / manual | filings, transcripts, market data, links | `fundamentals` + `thesis` snapshot, `forward_note` | FMP, Fiscal.ai, S&P Global, Morningstar, SEC/EDGAR, code execution, web |
| 3 | News & Events Monitor | **daily**, per asset | news, wires, press, filing feed, links | `current_events` notes (primary + read-through) + rolling outlook; escalates sentiment | MT Newswires, Bigdata.com, web, filing feed |
| 4 | Brand / Sentiment | full cycle + **event-escalated window** | social, reviews, trends | `brand_sentiment` | social/web APIs, Bigdata.com, MT Newswires, web |
| 5 | Synthesis / Memo | post-approval | full canonical file | `company_memo` | code execution (render), design system |
| 6 | Sector Cohort | constituent change / manual | many canonical files | `cohort_file` + `sector_report` | code execution, data layer |
| 7 | Content Generation | post-approval | canonical, cohort, memo | `podcast_script`, `shortform_pack`, `newsletter` | LLM, design system, plain-language layer |
| 8 | Orchestrator | all triggers | calendar, webhooks, app | jobs, status, notifications | scheduler, queue, webhooks |

Signal ingestion is a webhook path, not an agent: it receives TradingView/pricing payloads, routes by `tradingview_symbol`, writes `signal_event` and the `signals` block, and may raise a trigger.

### 4.2 Engine 2 — Fundamental Research (two passes around a known filing)

Fundamental Research runs in two passes that form a fluid loop around each known filing date.

**Forward pass** — triggered as `next_earnings_date` approaches (default T-minus N days, configurable). It does not wait for the filing; it stages the cycle by framing the forward view: what the market expects, what this print needs to show, and the specific conditions that would confirm or break the current thesis. It writes a `forward_note` into `current_events` and pre-warms model inputs so the coverage pass is fast.

**Coverage pass** — triggered the moment the actual filing lands (10-K, 10-Q, 8-K, S-1, proxy; earnings results arrive as filings, so this covers earnings). It retrieves the filing and transcript, extracts statements, refreshes the model, and measures actual against the forward pass's expectations, then drafts the updated thesis with tensions and invalidation triggers and appends a snapshot. Because the forward pass already framed expectations, this pass is a fast turn into coverage, not a cold start.

Both passes carry the latest `current_events.rolling_outlook` in as context. On filing arrival, the coverage pass also runs read-through (4.6) so a company's own filing propagates to its linked assets.

### 4.3 Engine 3 — News & Events Monitor (daily)

Runs every day for every asset with status in {in_research, in_review, published, monitoring}; batched. Purpose: keep each asset's current-events picture up to date and detect when something material has happened.

Steps:
1. Gather news/wire/press items since last run; dedupe against existing notes.
2. Grade each item for importance (rubric below).
3. For any item scoring at or above the flag threshold, run impact analysis: effect on forward outlook, effect on thesis (supports / pressures / neutral / invalidates a named trigger), effect on sentiment, estimated magnitude.
4. Write a `news_note` (origin.kind = `primary`) per material item; update `current_events.rolling_outlook`.
5. **Read-through pass.** For any material item, traverse the originating company's relationship links (3.8). For each linked asset, assess whether the event has a material read-through (e.g., a supplier's guidance cut pressures its customer; a competitor's price war pressures the peer; a regulatory action hits the thematic group). For each material read-through, write a `news_note` on the affected asset with origin.kind = `read_through`, referencing the source event and the link it traveled. Read-through is depth-limited (default 2 hops) and materiality-gated at each hop to prevent runaway. If a materially affected asset is not yet in the universe, create it as a `watchlist` company so the read-through is recorded rather than lost.
6. If an item scores at or above the escalation threshold, enqueue a Brand/Sentiment run with a coverage window of N days following the event — for the originating asset and for any asset that received a major-band read-through.

Importance rubric (0–100):

| Band | Score | Action |
|---|---|---|
| Low | 0–39 | logged as context only |
| Material | 40–69 | logged + `flagged` for human review; rolling outlook updated |
| Major | 70–100 | logged + `escalated`; triggers a Brand/Sentiment run for `window_days` (default 7; tune by magnitude) |

Scoring inputs: proximity to thesis and invalidation triggers, guidance/financial impact, management/governance change, legal/regulatory action, M&A or capital-markets action, and breadth of coverage. The rubric thresholds are configuration, not code, so they can be tuned without a rebuild.

### 4.4 Engine 4 — Brand / Sentiment (cadence + event-escalated)

Runs as part of a full cycle and on event-escalation from Engine 3 (a defined window after a major event). Produces platform-level signal, ground-momentum narrative, and the sentiment-vs-fundamentals gap. Degrades gracefully: a missing platform lowers confidence and is flagged, never fails the run.

### 4.5 Orchestration

```
TRIGGERS
  Filing date approaching -> Fundamental Research FORWARD pass (stage the cycle)
  Filing webhook (arrival) -> Fundamental Research COVERAGE pass (fast turn) + read-through
  Daily schedule          -> News & Events Monitor (per asset) + read-through pass
  News/event escalation   -> Brand/Sentiment run for window_days (origin + read-through assets)
  TradingView alert       -> signal logged; material alert may flag/trigger
  Manual                  -> any run, from the app
  Calendar                -> the human planning surface for known filing dates

THE FLUID LOOP (per asset, anchored on the known next filing date)
  ── between filings ──
    Daily monitor keeps current_events + rolling_outlook fresh; read-through flows across links
  ── as filing date nears ──
    Forward pass frames expectations + confirm/break conditions (forward_note)
  ── filing lands ──
    Coverage pass: actual vs expected -> snapshot, fast
    || Sentiment (+ live Signals + current_events context)
    -> read-through propagated to linked assets
    -> HUMAN CHECKPOINT (thesis, gap, signals, current events, read-throughs; approve/edit)
    -> Memo + Cohort refresh
    -> Content Generation (memo-derived script, short-form, newsletter)
    -> Content Library
  ── back to between-filings monitoring ──
```

Jobs are durable and idempotent (a re-run appends a new snapshot, never corrupts a prior one). Dependency order: research → synthesis → content; cohort refresh follows any constituent change. The human checkpoint between research and content is mandatory and is both the quality gate and the disclosure gate. Agents draft; a human approves; only then is content generated. The News & Events Monitor writes continuously and does not require the checkpoint, but an escalation that materially changes the thesis surfaces for review.

### 4.6 Coverage scope and read-through

Coverage is relational and bounded by explicit rules so it stays thorough without sprawling. Build to these guidelines exactly.

**What is in scope for a covered asset.** Its own fundamentals, thesis, sentiment, and signals; plus assessment of events that reach it through its relationship links — direct (supplier, customer, competitor, parent, subsidiary, JV) and material indirect (sector peer, shared end-market, thematic, macro-correlated). In-sector and cross-sector links are both in scope; a supplier or customer in a different GICS sector is exactly the kind of read-through that must not be missed.

**How read-through travels.** When a material event hits asset A, the system walks A's links and evaluates each neighbor B for a material effect, recording a read-through note on B. Cross-sector links are followed, not just intra-sector. Read-through then re-evaluates from B to B's links, depth-limited (default 2 hops) and materiality-gated at every hop, so an event only travels as far as it remains material. The link `type` and `direction_note` tell the analysis how the effect is expected to flow (a supplier's cost shock pressures a customer's margin; a competitor's discounting pressures a peer's pricing).

**Materiality gating.** Each hop applies the same 0–100 rubric. Only items at or above the flag band create a read-through note; only major-band read-throughs escalate sentiment or surface for review. This keeps the graph from generating noise.

**Out-of-universe assets.** If a material read-through lands on an asset not yet covered, create it as a `watchlist` company and record the read-through there. Nothing material is silently dropped; the watchlist becomes a sourced pipeline of "names the data told us to look at."

**Link maintenance.** Links are seeded at ingestion (peers from GICS, obvious competitors), enriched by Fundamental Research (suppliers, customers, and concentrations read out of filings), and curated by hand. Stale links are flagged for re-verification on each coverage pass.

---

## 5. Audience and the plain-language layer

The knowledge base is rigorous; the outputs are welcoming. A plain-language translation layer sits in front of Engines 5 and 7. It maintains a running glossary and rewrites analysis into approachable language — defining or avoiding jargon, using everyday analogies, and assuming no prior expertise. Every consumable intended for an audience is produced through this layer. Internal data consumables (canonical file, cohort file, notes) retain full technical precision.

---

## 6. Consumables Specification

This is the contract for everything the engine produces. Each consumable below has a fixed producer, set of consumers, format, and structure. Build to these exactly. Structures are normative; do not add, rename, or reorder top-level sections without a spec change.

### 6.1 Consumable catalog

| Consumable | Producer | Consumers | Format | Audience |
|---|---|---|---|---|
| Company index record | Engine 1 | app, all engines | DB row | internal |
| Canonical company file | Engines 2/3/4 + signals | Engines 5/6/7, app | Postgres (JSONB) | internal |
| News note | Engine 3 | canonical file, app, Engine 7 | DB row | internal |
| Signal event | webhook ingest | canonical file, app | DB row | internal |
| Sector cohort file | Engine 6 | Engine 7, app | Postgres (JSONB) | internal |
| Company memo | Engine 5 | publication, app | HTML + PDF | audience |
| Sector report | Engine 6 | publication, app | HTML + PDF | audience |
| Podcast script | Engine 7 | hosts/production | structured doc (HTML/MD) | production |
| Short-form pack | Engine 7 | production | structured list (JSON/MD) | production |
| Newsletter | Engine 7 | Substack | Markdown | audience |

Internal consumables use the schemas in section 3 as their authoritative definition. The audience- and production-facing consumables are defined precisely below.

### 6.2 Company Memo

Format: HTML rendered from the design system, PDF export. Audience: everyday investor. Every factual claim carries an inline provenance link. Tone produced through the plain-language layer. Fixed sections, in order:

1. **Header** — company, ticker, sector, market, snapshot date and cycle label; an "Education, not advice" badge; positions held.
2. **The one-liner** — the thesis in a single plain sentence.
3. **What they do** — the business in plain language.
4. **The numbers that matter** — three to six key figures, each with a one-line plain explanation. No tables of raw financials.
5. **The value picture** — bear / base / bull, expressed as what would make the asset look cheap, fair, or rich, in plain terms.
6. **What could go right** — catalysts.
7. **What could go wrong** — tensions and the named invalidation triggers.
8. **Where price is now** — the `signals` read: price relative to the value picture, TradingView alerts summarized in plain language.
9. **Ground truth** — the sentiment read and the sentiment-vs-fundamentals gap, plainly stated.
10. **What we're watching** — invalidation triggers plus the current `rolling_outlook` from current events.
11. **Footer** — full disclosure, positions held, and the provenance source list.

### 6.3 Sector Report

Format: HTML + PDF. Audience: everyday investor. Fixed sections:

1. **Header** — scope (sub-industry, markets), date.
2. **The sector in a sentence** — plain.
3. **Comparative view** — one legible table: valuation, margins, growth, sentiment per constituent.
4. **Leaders and laggards** — plain.
5. **Where the value looks to be** — the value opportunity.
6. **Biggest divergences** — where sentiment and fundamentals disagree most.
7. **Footer** — disclosure, constituents list, sources.

### 6.4 Podcast Script

Format: structured document. Audience: the hosts (production input, not a published artifact). The engine supplies substance and a plain-language draft only; structure, order, tone, pacing, and all creative and editorial decisions belong to the hosts. Contents:

1. **Metadata** — companies/sector covered, cycle label, authors, the spoken-disclosure block to read aloud.
2. **Substance segments** — for each topic: the point in plain language, the supporting facts and figures, and the relevant sentiment/signal context. Lines are attributed by author where authorship is known. No directorial instructions are emitted.
3. **Facts and figures appendix** — every figure used, each with its provenance link, for fact-checking.

### 6.5 Short-form Pack

Format: structured list (JSON or Markdown). Audience: production. For each clip candidate:

`{ source_ref, hook, point_in_one_breath, visual_idea, platform: [shorts|reels|tiktok], suggested_caption, on_screen_text, disclosure_caption }`

### 6.6 Newsletter

Format: Substack-ready Markdown. Audience: everyday investor, produced through the plain-language layer. Fixed sections:

1. **Title.**
2. **Opening** — welcoming, plain, sets up the issue.
3. **Body** — the memo's substance in conversational prose (the value picture, what's right/wrong, where price is, ground truth).
4. **What we're watching** — invalidation triggers and current events.
5. **Footer** — positions held and the standard disclosure, auto-appended.
6. **Sources** — provenance links.

---

## 7. Application

### 7.1 Stack — owned, on DigitalOcean

| Concern | Choice | Notes |
|---|---|---|
| Hosting | DigitalOcean Droplet(s), owned | Ubuntu; Nginx or Caddy reverse proxy |
| App | Next.js (Node) on the droplet | behind the proxy |
| Database | Self-hosted Postgres + pgvector (or DO Managed Postgres) | the proprietary knowledge base; pgvector for semantic search across the corpus |
| Raw blob storage | DO Spaces (S3-compatible) | raw filings, PDFs, audio, rendered artifacts |
| Orchestration | pg-boss (Postgres-backed queue) + Node worker + cron | fully self-hosted; cron runs the daily monitor; no external runtime |
| Webhook ingest | endpoint on app/worker | TradingView alerts + filing webhooks |
| Agent reasoning | Claude API | external reasoning calls |
| Email | Resend → Substack | newsletter delivery |

The only required external runtime is the Claude API. Self-hosted Postgres gives full control; DO Managed Postgres trades some control for automated backups and failover. Both keep data on owned infrastructure.

### 7.2 Application data model

`sectors` · `markets` · `companies` · `company_links` (the relationship graph) · `canonical_files` (versioned, JSONB) · `news_notes` (primary + read-through) · `signal_events` · `cohort_reports` · `content_items` · `raw_documents` (metadata; blobs in Spaces) · `jobs` (pg-boss) · `sources` (provenance).

### 7.3 Screens

| Screen | Purpose | Actions |
|---|---|---|
| Universe / Explorer | navigable taxonomy, re-rootable, faceted search | browse, filter, search |
| Company | the canonical file rendered: fundamentals · thesis · sentiment · signals (price + TV alerts) · current events feed (primary + read-through) · **relationships (linked assets, in- and cross-sector)** · governance · events · linked content · positions · snapshot diff | run pipeline, run single engine, approve thesis, edit links, generate outputs |
| Relationships | a graph view of a company's links and the read-throughs that have traveled them; click an edge to see the originating event and the affected asset | add/edit/verify links, jump to linked asset |
| Add Company | ticker in → Ingestion → appears in Universe | add, classify, set authors + TradingView symbol, seed links |
| Sector | cohort report, comparative tables, where the opportunity is | refresh cohort, generate report |
| Calendar | a literal month/week calendar of earnings dates across the universe, color-coded by coverage status; click a date to open the company; planned content overlaid | jump to company, plan content, pre-stage a cycle |
| Pipeline / Jobs | live cycle status, the queue, the daily monitor runs, the alert and news feeds | trigger, reschedule, retry, inspect |
| Content Library | every memo, report, script, short-form pack, newsletter; filter by company/sector/date | view, edit, export, publish |

### 7.4 Control surface

Add company · run full cycle · run single engine · run/inspect daily monitor · approve thesis (checkpoint) · generate each content type · publish/export · diff two snapshots · view and route incoming TradingView alerts and news notes.

---

## 8. Cross-cutting requirements

**Provenance.** Every material claim in every consumable links to a Tier-1 source. Provenance is written as the agent works.

**Disclosure.** `positions_held` propagates from company → thesis → every audience consumable footer, automatically. Education-and-opinion framing for an everyday audience is the template default.

**Versioning.** Snapshots are append-only; the snapshot diff is a first-class feature and the primary input to "what changed" content.

**Reliability.** Every engine emits a confidence score and a missing-sources list; low confidence blocks auto-publish and routes to human review. Source adapters are isolated so a single dead API never fails a cycle.

**Compliance.** One-time professional consult on financial-promotion and disclosure rules for the operating jurisdiction(s) before publishing at scale.

---

## 9. Build order

Bottom-up, because everything depends on the contract. (1) Postgres schema for the knowledge base, raw landing zone, the relationship graph (`company_links`), and Spaces wiring. (2) TradingView and filing webhook ingest paths, populating signals and triggering on filings. (3) News & Events Monitor with the daily cron — current-events context starts accumulating immediately and is cheap; add the read-through pass once `company_links` is seeded. (4) Fundamental Research engine with its forward and coverage passes. (5) Universe + Company + Relationships screens. (6) Calendar screen and the forward-pass scheduler keyed to known filing dates. (7) Brand/Sentiment engine with event-escalation. (8) Memo and Content Generation engines with the plain-language layer. (9) Sector Cohort engine, once enough canonical files exist to compare.
