# Investing Together — Build Plan

**Status:** Pre-build. No code written yet (intentionally — this plan is the contract).
**Companion docs:** the architecture spec is the source of truth for *what* we build; this plan is *how and in what order*, with testing milestones and a definition of done per phase.
**Audience:** the builder (Claude Code, working on owned DigitalOcean infrastructure) and you (the owner/operator + human checkpoint).

---

## 0. How to read this plan

- **Section 1 — Access & prerequisites.** What I need from you before breaking ground: DigitalOcean droplet access and Claude API access, plus the supporting data-source keys. This is the gate; nothing in the phases starts until Phase 0 (provisioning) can run.
- **Section 2 — Locked decisions & open questions.** The architectural calls I'm making, and the few that are genuinely yours to make.
- **Section 3 — Cross-cutting foundations.** Things every phase must honor: provenance, disclosure, the testing strategy, agent-output evaluation, secrets, and observability.
- **Section 4 — The phased plan.** Ten phases (0–9), each with: objective, work, **testing milestone**, and **definition of done (DoD)**. Phases map to the architecture's build order (§9) with provisioning prepended.
- **Section 5 — Agent engine implementation approach.** How the eight engines get built and tested, including model selection and the eval harness.
- **Section 6 — Dependency graph & sequencing.**
- **Section 7 — Risk register.**

The cadence is iterative: build a phase, hit its testing milestone, demo it, then proceed. Each phase leaves `main` (well, the feature branch) in a working, tested state.

---

## 1. Access & prerequisites — what I need from you

I cannot break ground until these are in place. Everything here lands in a secrets manager or `.env` on the droplet — never in git. Provide them when you're ready; I'll confirm each works in Phase 0 before building on it.

### 1.1 DigitalOcean droplet access

The platform runs on owned infrastructure (spec §7.1). To provision and operate it I need:

| What | Why | Notes |
|---|---|---|
| **SSH access to the droplet** | Deploy, run migrations, manage the worker/cron | Add my public key to the droplet's `authorized_keys`, or create a non-root `deploy` sudo user and share its key. Give me the **droplet IP/hostname** and the **login user**. |
| **A `doctl` API token** (read/write) | Create & manage DO Spaces buckets, optionally DO Managed Postgres, firewalls, snapshots | Generate at DO → API → Tokens. Scope to the project if you use DO projects. |
| **Droplet sizing confirmation** | Right-size before we provision | My recommendation below — confirm or adjust. |
| **Domain name** (optional, recommended) | TLS + a real URL for the app and webhooks | If you have one, point an A record at the droplet; I'll set up Caddy for automatic HTTPS. Webhooks (TradingView, filings) need a stable public URL. |

**Recommended droplet to start:** a single **4 GB RAM / 2 vCPU / 80 GB SSD** droplet (Ubuntu 24.04 LTS) running app + worker + self-hosted Postgres + pgvector. This comfortably covers early coverage (tens of companies). We scale up (or split Postgres onto DO Managed Postgres) when daily-monitor volume or pgvector search load demands it — that decision is in Phase 1 and again before launch.

**What I will NOT need:** your DO account password, billing access, or root if a sudo `deploy` user exists.

**If you can't grant SSH yet:** I can still do Phases 1–4 worth of code (schema, ingest, engines) in this repo and validate against a local Postgres, then deploy to the droplet once access lands. Provisioning (Phase 0) and anything webhook- or cron-dependent is what's blocked without it.

### 1.2 Claude API access (the only required external runtime)

The agent engines reason via the Claude API (spec §4.1, §7.1). I need:

| What | Why |
|---|---|
| **An `ANTHROPIC_API_KEY`** | All eight engines' reasoning calls |
| **Confirmation of your usage tier / rate limits** | So I size batching, concurrency, and the daily-monitor fan-out to your limits |
| **A monthly spend ceiling you're comfortable with** | I'll build cost controls (model tiering, prompt caching, batching) to live under it and alert before it's hit |

**Models I plan to use** (current IDs; all reason via one `ANTHROPIC_API_KEY`):

| Use | Model | ID | Price (in/out per 1M tok) | Why |
|---|---|---|---|---|
| Heavy reasoning: Fundamental Research synthesis, thesis, read-through judgment, plain-language layer | **Claude Opus 4.8** | `claude-opus-4-8` | $5 / $25 | Most capable; adaptive thinking + high/xhigh effort for the hard synthesis and the cross-asset read-through calls |
| High-volume daily work: News & Events grading, impact analysis, first-pass read-through, sentiment summarization | **Claude Sonnet 4.6** | `claude-sonnet-4-6` | $3 / $15 | Best speed/intelligence balance for the per-asset daily pulse across the whole universe |
| Cheap, mechanical: dedupe checks, importance pre-filter, classification | **Claude Haiku 4.5** | `claude-haiku-4-5` | $1 / $5 | Fastest/cheapest for the high-count, low-judgment steps |

Cost levers baked in from day one: **prompt caching** of the large canonical-file context (the substrate is read repeatedly per cycle — caching the stable prefix cuts cost ~90% on cache reads), the **Batch API** (50% off) for the non-latency-sensitive daily monitor sweep, and **model tiering** so Opus is reserved for genuine judgment. I'll show projected cost per cycle and per daily-sweep once we have a representative company.

> Note on Managed Agents: Anthropic offers a server-managed agent runtime, but the spec mandates *owned* infrastructure and a self-hosted pg-boss orchestrator. So I'll build the engines as **Claude API + tool use** (we host the loop on the droplet), not Managed Agents. Flagged as a reversible decision in §2.

### 1.3 Data-source API keys (per engine, supplied as you go)

These aren't all needed up front — each is needed when its engine is built. I'll request each one as its phase begins, and every adapter degrades gracefully if a key is missing (spec §8 reliability), so a missing source never fails a cycle.

| Source | Used by | Needed at phase |
|---|---|---|
| **TradingView** (webhook alerts — no key, just the webhook URL + shared secret I generate) | Signal ingest | Phase 2 |
| **Filing webhook / SEC EDGAR** (EDGAR is free; a filing-alert provider may need a key) | Ingest, Fundamental Research | Phase 2 / 4 |
| **FMP** (Financial Modeling Prep) | Ingestion/Identity, Fundamental Research | Phase 1 / 4 |
| **Fiscal.ai**, **S&P Global**, **Morningstar** | Fundamental Research | Phase 4 |
| **MT Newswires**, **Bigdata.com** | News & Events, Brand/Sentiment | Phase 3 / 7 |
| **Social/web APIs** | Brand/Sentiment | Phase 7 |
| **Resend** (newsletter delivery → Substack) | Content Generation | Phase 8 |

For each, tell me which you already have accounts for; I'll write the adapter against the ones you have and stub the rest behind the graceful-degradation interface.

---

## 2. Locked decisions & open questions

### Locked (my call, with rationale — say the word to change any)

1. **Stack = spec §7.1 as written.** Next.js (Node) app, self-hosted Postgres + pgvector, DO Spaces, pg-boss + Node worker + cron, Caddy reverse proxy, Resend for email. TypeScript end to end.
2. **Engines run as Claude API + tool use on our own worker**, not Managed Agents (owned-infra requirement). Reversible.
3. **Canonical file = JSONB document + append-only snapshot rows.** Heavy engine output stored as JSONB matching the §3.4 sub-schemas; queryable fields (as_of, cycle_label, trigger, conviction) promoted to columns. Snapshots are immutable; re-runs append (spec §4.5, §8).
4. **Importance rubric thresholds + read-through depth are configuration, not code** (spec §4.3, §4.6) — a config file/table, tunable without a rebuild.
5. **Model tiering** as in §1.2.
6. **Self-hosted Postgres on the app droplet to start**, with a clean migration path to DO Managed Postgres if/when we want managed backups + failover.

### Open — your call (I'll ask via a focused question at the relevant phase, not now)

- **Self-hosted vs DO Managed Postgres** for launch (control vs automated backups/failover). Defaulting to self-hosted; revisit before Phase 9.
- **Which data sources you already hold accounts for** (drives adapter order in §1.3).
- **Spend ceiling and DO budget.**
- **Operating jurisdiction(s)** for the one-time financial-promotion/disclosure compliance consult (spec §8) — affects launch, not the build.

---

## 3. Cross-cutting foundations (every phase honors these)

- **Provenance (spec §8).** Every material claim written by any engine carries a link to a Tier-1 source row. Provenance is written *as the agent works*, not bolted on. Enforced by schema (the `sources` table + provenance arrays) and checked in tests.
- **Disclosure (spec §8).** `positions_held` propagates company → thesis → every audience consumable footer, automatically. An audience consumable with no disclosure footer is a test failure.
- **Versioning (spec §8).** Snapshots append-only; the snapshot diff is a first-class feature and the primary input to "what changed" content.
- **Reliability (spec §8).** Every engine emits a confidence score + missing-sources list. Low confidence blocks auto-publish and routes to human review. Source adapters are isolated behind one interface so a single dead API never fails a cycle.
- **Testing strategy (applies to all phases):**
  - **Unit** — pure logic: rubric banding, read-through traversal/gating, plain-language transforms, schema validation. Fast, no network.
  - **Integration** — against a real ephemeral Postgres (the migration runner + a seeded fixture DB); source adapters tested against recorded fixtures, not live APIs.
  - **Agent-output evals** — the engines are LLM-driven, so "tests" for them are an **eval harness**: a small set of golden inputs (real filings/news with known correct read-throughs, importance bands, thesis effects) scored for accuracy, provenance completeness, and schema conformance. This is how we catch regressions when prompts or models change (§5).
  - **End-to-end** — one company driven through the fluid loop (ingest → forward pass → filing → coverage → checkpoint → memo) on the droplet, asserting the artifacts produced.
- **Secrets.** `.env` on the droplet (root-owned, `chmod 600`) or a secrets manager; never in git. `.env.example` documents every variable. CI/build never prints secrets.
- **Observability.** Structured logs from the worker; a Jobs/Pipeline screen (Phase 5+) shows live cycle status, the queue, daily-monitor runs, and the alert/news feeds (spec §7.3). Per-engine confidence + missing-sources surfaced there.

---

## 4. The phased plan

> Each phase ends at a **testing milestone** and a **definition of done**. We don't start phase N+1 until phase N's DoD is met and demoed.

### Phase 0 — Provisioning & environment (the gate)

**Objective:** a reachable, secured droplet running Postgres + pgvector, Spaces wired, the Claude API key validated, and a deploy path.
**Work:** SSH hardening + `deploy` user; install Node 20 LTS, Postgres 16 + pgvector, Caddy; create the Spaces bucket via `doctl`; install the repo; set up `.env`; smoke-test a Claude API call and a Spaces upload; TLS via Caddy if a domain is provided.
**Testing milestone:** `db:migrate` runs against droplet Postgres; a scripted health check confirms (a) Postgres reachable + pgvector present, (b) a round-trip object PUT/GET to Spaces, (c) a 1-token Claude API call returns 200, (d) the app serves a "hello" page over HTTPS.
**DoD:** all four health checks green; deploy is one documented command; secrets in place, none in git.
**Blocked by:** §1.1 SSH + doctl, §1.2 API key.

### Phase 1 — Schema & knowledge base foundation (spec §9.1)

**Objective:** the full Postgres schema for the knowledge base, raw landing zone, and the **relationship graph** (`company_links`), plus the TypeScript type contract mirroring spec §3, and Spaces wiring for blobs.
**Work:** migrations for sectors/GICS, markets, companies, company_links, canonical_files + append-only snapshots, news_notes (primary + read_through), signal_events, cohort_reports, content_items, raw_documents, sources; the data-access layer; the rubric/read-through config; a seed of GICS reference data; Ingestion/Identity engine (Engine 1) to add a company from a ticker.
**Testing milestone:** unit tests for type/schema conformance; integration test that applies all migrations to a fresh DB, seeds GICS, runs Engine 1 on a real ticker, and asserts a company + canonical skeleton + seeded peer links exist with correct GICS path.
**DoD:** schema applies cleanly and idempotently; Engine 1 adds a classified company with seeded links; types and DB shapes match spec §3 exactly.

### Phase 2 — Ingest paths: webhooks & signals (spec §9.2)

**Objective:** TradingView and filing webhooks land Tier-1 data and raise triggers.
**Work:** signed webhook endpoints; route TradingView payloads by `tradingview_symbol` → `signal_event` + the `signals` block; filing webhook → `raw_document` + a coverage-pass trigger; provenance-stamp on arrival; the trigger/queue plumbing (pg-boss).
**Testing milestone:** integration tests POST recorded TradingView and filing payloads (valid + bad-signature) and assert the right rows are written, the wrong ones rejected, and the correct job is enqueued. Idempotency test: a replayed webhook doesn't double-write.
**DoD:** both webhook paths verified end to end against fixtures on the droplet; a live TradingView test alert from your account lands and is visible.

### Phase 3 — News & Events Monitor + read-through (spec §9.3, §4.3, §4.6)

**Objective:** the daily pulse — per-asset news gathering, importance grading, impact analysis, and the **read-through pass** across `company_links`.
**Work:** daily cron; gather/dedupe; grade (0–100 rubric, config-driven bands); impact analysis; write `news_note` (primary); update `rolling_outlook`; **read-through traversal** (depth-limited, materiality-gated, cross-sector, watchlist-creation for out-of-universe assets); escalation enqueue for major-band items.
**Testing milestone:** **unit** — rubric banding + read-through traversal/gating with a hand-built link graph (assert depth limit, materiality gate, cross-sector follow, watchlist creation). **Eval** — a golden set of ~10 real events with known correct importance band, thesis effect, and expected read-throughs; score accuracy + provenance completeness + schema conformance. **Integration** — a seeded universe + recorded news feed produces the expected notes and watchlist entries.
**DoD:** daily monitor runs on cron; current_events accumulates; read-through demonstrably travels A→B (in- and cross-sector) and stops when immaterial; eval scores meet an agreed bar.

### Phase 4 — Fundamental Research engine (spec §9.4, §4.2)

**Objective:** the two-pass fluid loop around a known filing date.
**Work:** **forward pass** (T-minus N days: frame expectations + confirm/break conditions → `forward_note`, pre-warm model inputs); **coverage pass** (on filing arrival: extract statements, refresh model via code execution, measure actual vs expected, draft thesis with tensions + invalidation triggers, append snapshot, run read-through to linked assets); link enrichment (suppliers/customers/concentrations read out of filings).
**Testing milestone:** **eval** — a golden 10-Q/10-K with a known-correct extraction and a reference thesis; score statement-extraction accuracy, provenance coverage (every claim sourced), schema conformance, and that invalidation triggers are present and specific. **Integration** — filing webhook → coverage pass → new append-only snapshot with the diff computed. **Idempotency** — re-running the coverage pass appends a second snapshot without corrupting the first.
**DoD:** forward + coverage passes run; a filing produces a sourced, schema-valid snapshot with a thesis and a diff; links get enriched from the filing.

### Phase 5 — Universe, Company & Relationships screens (spec §9.5, §7.3)

**Objective:** see and operate the knowledge base.
**Work:** Universe/Explorer (re-rootable, faceted search); Company screen (canonical file rendered: fundamentals · thesis · sentiment · signals · current-events feed with primary + read-through · **relationships** · governance · events · snapshot diff); Relationships graph view (click an edge → originating event + affected asset); Pipeline/Jobs screen (live status, queue, daily-monitor runs, feeds); control surface (run pipeline, run single engine, approve thesis, edit links).
**Testing milestone:** component/integration tests render seeded canonical data; the **human checkpoint** (approve/edit thesis) is exercised; the Relationships view shows a real read-through path; the Jobs screen reflects a running/queued job.
**DoD:** you can browse the universe, open a company, read its canonical file + read-throughs, edit links, watch the pipeline, and approve a thesis.

### Phase 6 — Calendar & forward-pass scheduler (spec §9.6)

**Objective:** the planning surface keyed to known filing dates, and the scheduler that pre-stages cycles.
**Work:** month/week Calendar of earnings dates across the universe, color-coded by coverage status, click-through to company, planned content overlaid; the forward-pass scheduler (T-minus N, configurable) that enqueues forward passes off `next_earnings_date`.
**Testing milestone:** unit tests for the scheduling logic (correct T-minus enqueue, no duplicate enqueues, handles moved dates); integration test that a company with a near earnings date gets a forward pass staged.
**DoD:** Calendar renders the universe; forward passes auto-stage ahead of known filing dates; you can pre-stage a cycle from the Calendar.

### Phase 7 — Brand/Sentiment engine with event-escalation (spec §9.7, §4.4)

**Objective:** platform-level sentiment, ground-momentum, and the sentiment-vs-fundamentals gap — on cadence and on event-escalation.
**Work:** the engine (by-platform signal, ground-momentum narrative, gap); event-escalated window triggered from Engine 3's major-band items (origin + major-band read-through assets); graceful degradation (a missing platform lowers confidence, flagged, never fails).
**Testing milestone:** unit — escalation window math + degraded-source handling. Eval — a golden set scoring sentiment direction + gap reasonableness + confidence calibration. Integration — a simulated major event escalates a sentiment run for the right assets.
**DoD:** sentiment runs on full cycle and on escalation; the gap is computed and rendered on the Company screen; a dead platform degrades gracefully.

### Phase 8 — Memo, Content Generation & the plain-language layer (spec §9.8, §5, §6)

**Objective:** the consumables — produced only post-checkpoint, through the plain-language layer, with provenance + disclosure.
**Work:** the plain-language translation layer (running glossary, jargon-free rewrite) in front of Engines 5 & 7; Engine 5 (company memo, fixed §6.2 sections, inline provenance, "Education, not advice" badge, disclosure footer, HTML + PDF render); Engine 7 (podcast script §6.4, short-form pack §6.5, newsletter §6.6 → Resend/Substack); Content Library screen.
**Testing milestone:** unit — every consumable's fixed-section structure is present and in order; disclosure footer + positions auto-appended; provenance links resolve. Eval — plain-language readability + "no jargon / no advice framing" check on golden memos. Integration — an approved thesis generates a memo + newsletter + short-form pack with intact provenance and disclosure.
**DoD:** post-checkpoint, a company produces a memo (HTML+PDF), newsletter (Markdown), and short-form pack — all family-friendly, all sourced, all disclosed; Content Library lists and exports them.

### Phase 9 — Sector Cohort engine + hardening & launch (spec §9.9, §8)

**Objective:** comparative sector pieces, then production-readiness.
**Work:** Engine 6 (cohort file + sector report) once enough canonical files exist to compare — comparative tables, leaders/laggards, where-the-value-is, divergences; Sector screen. Then hardening: backups (Postgres + Spaces), monitoring/alerting, the spend-ceiling alerting, the self-hosted-vs-managed-Postgres decision, and the **one-time professional compliance consult** on financial-promotion/disclosure rules for your jurisdiction before publishing at scale.
**Testing milestone:** integration — a cohort across ≥3 companies produces a valid cohort file + sector report with provenance. Ops — a restore-from-backup drill; an alert fires on a simulated failure; a spend-ceiling alert fires.
**DoD:** sector reports generate; backups + monitoring + spend alerts verified; compliance consult complete; the full fluid loop runs end-to-end for a real company through to published content.

---

## 5. Agent engine implementation approach

**Shape.** Eight single-responsibility engines, coordinated by the orchestrator (no engine calls another directly — the orchestrator enqueues jobs). Each engine: (1) reads its defined inputs, (2) does Claude-API reasoning with tool use (code execution for modeling, web/search adapters, the data layer), (3) writes its one defined consumable, (4) emits a confidence score + missing-sources list. Jobs are durable and idempotent via pg-boss.

**Model + cost choices** are in §1.2. Concretely: Opus 4.8 with adaptive thinking at `high`/`xhigh` effort for Fundamental Research synthesis, thesis drafting, read-through judgment, and the plain-language layer; Sonnet 4.6 for the daily-monitor grading/impact/first-pass read-through across the whole universe; Haiku 4.5 for dedupe and importance pre-filtering. The canonical-file context is **prompt-cached** (stable prefix) so repeated reads within a cycle are cheap; the daily sweep uses the **Batch API** where latency isn't critical.

**Provenance & disclosure are produced inline**, not post-hoc — the prompts require a source ref for each claim, and tests reject claims without one. Disclosure footers are templated and auto-filled from `positions_held`.

**The eval harness is how we "unit test" the engines.** For each LLM-driven engine we keep a small, version-controlled golden set (real filings/news/events with human-verified correct outputs: importance band, thesis effect, expected read-throughs, extraction values). A run scores accuracy, provenance completeness, and schema conformance against that set. This is what guards against silent regressions when we change a prompt or bump a model — and it's the gate for "did the engine get better or worse." Adversarial/verification passes (a second model checking a finding) are used where correctness matters most (read-through materiality, invalidation triggers).

**The human checkpoint is mandatory** between research and content (spec §4.5) and is both the quality gate and the disclosure gate. Agents draft; you approve; only then is content generated. The daily monitor writes continuously without the checkpoint, but an escalation that materially changes the thesis surfaces for review.

---

## 6. Dependency graph & sequencing

```
Phase 0 (provisioning) ─ gate ─┐
                               ▼
Phase 1 (schema + Engine 1) ───┬──────────────────────────────┐
   │                           │                              │
   ▼                           ▼                              ▼
Phase 2 (webhooks/signals)   Phase 3 (daily monitor +       Phase 5 (Universe/
   │                          read-through, needs links)     Company/Relationships)
   ▼                           │                              │
Phase 4 (Fundamental ◄─────────┘ (read-through shared)        │
   Research, 2 passes)                                        │
   │                                                          │
   ▼                                                          ▼
Phase 6 (Calendar + forward scheduler, needs Phase 4 + 5) ────┘
   │
   ▼
Phase 7 (Brand/Sentiment, escalated from Phase 3)
   │
   ▼
Phase 8 (Memo + Content + plain-language, needs checkpoint from Phase 5)
   │
   ▼
Phase 9 (Sector Cohort — needs several canonical files — + hardening + launch)
```

Rationale follows spec §9: bottom-up, because everything depends on the schema contract; current-events context starts accumulating early (Phase 3) because it's cheap and compounding; content generation is late because it depends on the checkpoint and the substrate; the cohort engine is last because it needs enough canonical files to compare.

---

## 7. Risk register

| Risk | Mitigation |
|---|---|
| **A data-source API is down or unkeyed** | Isolated adapter interface + graceful degradation (confidence drop + missing-sources flag); a dead source never fails a cycle (spec §8). |
| **LLM cost overruns** | Model tiering, prompt caching of the canonical-file prefix, Batch API for the daily sweep, a spend ceiling with alerting (Phase 9). I'll show projected per-cycle cost early. |
| **Read-through graph runaway** | Depth limit (default 2 hops) + materiality gate at every hop, both config (spec §4.6); tested explicitly in Phase 3. |
| **Engine regression on prompt/model change** | The eval harness (§5) is the gate; golden sets per engine; adversarial verification where correctness is critical. |
| **Bad/forged webhook data** | Signed webhooks, signature-rejection tests, idempotent writes (Phase 2). |
| **Compliance/financial-promotion exposure** | "Education, not advice" framing as template default; disclosure auto-propagation; the one-time professional consult before publishing at scale (Phase 9, spec §8). |
| **Single-droplet failure / data loss** | Postgres + Spaces backups and a restore drill (Phase 9); clean migration path to DO Managed Postgres for managed failover. |
| **Snapshot corruption** | Append-only, idempotent jobs — re-runs append, never mutate prior snapshots (tested in Phase 4). |

---

## 8. Immediate next step

To break ground on **Phase 0**, I need from §1.1 and §1.2:
1. SSH access to the droplet (+ login user) and a `doctl` token,
2. confirmation of the droplet size (my rec: 4 GB / 2 vCPU / 80 GB, Ubuntu 24.04),
3. an `ANTHROPIC_API_KEY` + your rate-limit tier and a monthly spend ceiling,
4. (optional but recommended) a domain pointed at the droplet for TLS + webhooks.

Tell me which of the §1.3 data sources you already hold accounts for, and I'll order the adapter work accordingly. Once Phase 0's four health checks are green, I'll proceed phase by phase, hitting each testing milestone and demoing before moving on.
