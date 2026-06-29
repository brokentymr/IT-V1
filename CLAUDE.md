# CLAUDE.md — Investing Together

You are Claude Code, running **directly on the owned DigitalOcean droplet** that hosts this platform. This file is your standing brief. Read it, then read the two documents it points to, before doing anything else.

---

## What this project is

**Investing Together** — an agentic research-and-content platform built on an owned, proprietary knowledge base. Raw materials (filings, news, market signals) flow in, are processed by a mesh of eight agent engines into a canonical, versioned research object per company, and are rendered into family-friendly investing content. The knowledge base *is* the business asset. Coverage is relational: events travel across a typed graph of company-to-company links (read-through).

## The three documents (source of truth, in this order)

1. **`docs/ARCHITECTURE.md`** — *what* we build. The authoritative contract. The data-model schemas (§3) and consumable structures (§6) are **normative** — read and write to those exact shapes; do not add, rename, or reorder normative fields/sections without flagging it as a spec change and getting sign-off.
2. **`docs/BUILD-PLAN.md`** — *how and in what order*. Ten phases (0 provisioning → 9 cohort + hardening/launch), each with a **testing milestone** and **definition of done (DoD)**. Access prerequisites, locked decisions, the eval-harness approach, the dependency graph, and the risk register live here.
3. **This file** — the *working method* and the guardrails that bind every phase.

If any instruction here conflicts with `ARCHITECTURE.md`, the architecture wins on *what* and you raise the conflict. This file wins on *how you work*.

---

## How we work — the per-phase loop

Build strictly phase by phase, in the order in `BUILD-PLAN.md` §4. For **each** phase:

1. **Fine-tune the plan for this phase first.** Before writing code, expand the phase's one-paragraph plan into a concrete task breakdown: the files/modules you'll create, the schema or interface changes, the adapters needed, and exactly how you'll meet the phase's testing milestone. Surface any decision that's genuinely the owner's to make (see *Open questions* in `BUILD-PLAN.md` §2) and **ask before building**, rather than guessing. Keep the breakdown short and concrete.
2. **Execute** the phase against that breakdown. Match the surrounding code's conventions. Honor the guardrails below.
3. **Test incrementally — this is the gate.** Hit the phase's **testing milestone** exactly as written in `BUILD-PLAN.md`:
   - **Unit** tests for pure logic (rubric banding, read-through traversal/gating, plain-language transforms, schema validation) — fast, no network.
   - **Integration** tests against a real ephemeral Postgres and recorded source fixtures (never live third-party APIs in tests).
   - **Agent-output evals** for the LLM-driven engines — score a small, version-controlled golden set for accuracy, **provenance completeness**, and schema conformance. This is how engine regressions are caught when a prompt or model changes.
   - **End-to-end** where the phase calls for it.
   Run the tests. Do not declare a phase done on green types alone — run the actual suite and show the output.
4. **Confirm the DoD is met**, then **stop and report**: what was built, the test results (real output, not a claim), anything skipped and why, and the cost/observability notes where relevant. Demo the phase's capability.
5. **Wait for the owner's go-ahead** before starting the next phase. Each phase must leave the working branch in a tested, working state.

Do not batch multiple phases. Do not skip the testing milestone. If a test fails, say so with the output and fix it before proceeding — a phase isn't done until its milestone is green.

---

## Guardrails — every phase honors these (from `ARCHITECTURE.md` §8 + the build plan)

- **Provenance is written as the agent works, not bolted on.** Every material claim in every consumable links to a Tier-1 `sources` row. A claim without a source ref is a test failure.
- **Disclosure auto-propagates.** `positions_held` flows company → thesis → every audience consumable footer, automatically. An audience consumable with no disclosure footer is a test failure. "Education, not advice" framing is the template default.
- **Snapshots are append-only.** Jobs are durable and idempotent — a re-run **appends** a new snapshot and never mutates or corrupts a prior one. The snapshot diff is a first-class feature.
- **Rubric thresholds and read-through depth are configuration, not code** (architecture §4.3, §4.6) — a config file/table, tunable without a rebuild. Read-through is depth-limited (default 2 hops) and materiality-gated at every hop, in- and cross-sector.
- **Reliability:** every engine emits a confidence score + missing-sources list; low confidence blocks auto-publish and routes to human review. Source adapters sit behind one isolated interface and degrade gracefully — a single dead API never fails a cycle.
- **The human checkpoint between research and content is mandatory** (architecture §4.5). Agents draft; the owner approves a thesis; only then is content generated. The daily monitor writes continuously without the checkpoint, but an escalation that materially changes the thesis surfaces for review.
- **Plain-language layer** sits in front of the audience-facing engines (5 & 7). Internal consumables keep full technical precision; audience consumables are jargon-free and welcoming.

---

## Stack & environment (you are on the droplet)

Per `ARCHITECTURE.md` §7.1, all on owned DigitalOcean infrastructure:

- **App:** Next.js (Node 20 LTS), behind Caddy (automatic HTTPS).
- **Database:** self-hosted Postgres + pgvector (the knowledge base). pgvector for semantic search across the corpus. Migration path to DO Managed Postgres kept open.
- **Blob storage:** DO Spaces (S3-compatible) — raw filings, PDFs, audio, rendered artifacts.
- **Orchestration:** pg-boss (Postgres-backed queue) + a Node worker + cron. Fully self-hosted; cron runs the daily monitor. No external runtime except the Claude API.
- **Webhooks:** signed endpoints on the app/worker for TradingView alerts and filing arrivals.
- **Agent reasoning:** Claude API (the only required external runtime). Email: Resend → Substack.

**Engines run as Claude API + tool use on our own worker** (we host the loop) — not Managed Agents — because the spec mandates owned infrastructure and a self-hosted orchestrator. (Reversible decision; see `BUILD-PLAN.md` §2.)

**Model tiering** (all via one `ANTHROPIC_API_KEY`):
- **`claude-opus-4-8`** — heavy reasoning: Fundamental Research synthesis, thesis, read-through judgment, plain-language layer. Use adaptive thinking; effort `high`/`xhigh` for the hard synthesis.
- **`claude-sonnet-4-6`** — high-volume daily work: News & Events grading, impact analysis, first-pass read-through, sentiment summarization.
- **`claude-haiku-4-5`** — cheap/mechanical: dedupe, importance pre-filter, classification.

**Cost discipline from day one:** prompt-cache the large canonical-file prefix (repeated reads per cycle); use the Batch API (50% off) for the non-latency-sensitive daily sweep; reserve Opus for genuine judgment. Live under the owner's spend ceiling and alert before it's hit. Show projected per-cycle and per-daily-sweep cost once a representative company exists.

---

## Conventions & hygiene

- **Secrets** live in `.env` on the droplet (root-owned, `chmod 600`) or a secrets manager — **never in git**. `.env.example` documents every variable. Never print a secret in logs or output.
- **Git:** develop on the designated feature branch; commit with clear, descriptive messages; commit/push only when the work is at a tested checkpoint or the owner asks. Branch off the default branch — don't push to it directly.
- **Migrations** are applied in order, each once, idempotently. Schema changes are migrations, never ad-hoc DDL.
- **Match the surrounding code** — its naming, structure, comment density, and idioms. Reference code as `file_path:line`.
- **Don't truncate** inputs silently (filings, news) — if content exceeds a context window, say so and chunk or summarize deliberately.
- **Report outcomes faithfully:** if tests fail, show the output; if a step was skipped, say so; state "done and verified" only when it is.

---

## Start here

1. Read `docs/ARCHITECTURE.md` and `docs/BUILD-PLAN.md` in full.
2. Confirm the access prerequisites in `BUILD-PLAN.md` §1 are in place (droplet reachable, `doctl` token, `ANTHROPIC_API_KEY`, Spaces, any data-source keys the owner has). Confirm which §1.3 data sources the owner already holds accounts for.
3. Begin **Phase 0 (Provisioning & environment)**: fine-tune its plan, execute, and run its four health checks (Postgres + pgvector reachable, Spaces round-trip, a 1-token Claude API call, the app served over HTTPS). Report the results and wait for the go-ahead before Phase 1.

Build one phase at a time. Test at every milestone. Stop and report at every DoD.
