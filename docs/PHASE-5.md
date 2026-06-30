# Phase 5 — Universe, Company & Relationships screens (the operator console) (record)

**Status:** ✅ complete — built, tested (62/62), live on https://markets.kuramoto.io (2026-06-30).

## Owner decisions (2026-06-30)
- **Access:** HTTP basic auth via Caddy (webhooks excluded — they use their own signed secrets).
- **Initial-run model:** the "run coverage" button **enqueues** the existing coverage job; progress
  is watched on the Pipeline screen (non-blocking).
- **Content pipeline:** "enroll" sets a `content_enrolled` flag now; actual generation is Phase 8.
- **Polish:** functional & clean operator dashboard (legible, fast, minimal CSS — no framework).

## What was built
- **Auth** (`deploy/Caddyfile`): `basic_auth` gates the whole console; `/api/webhooks/*` stays open.
  Only the bcrypt hash is in the repo; the plaintext password lives outside git.
- **Migration 0009**: `companies.content_enrolled`; `thesis_approvals` table (the human checkpoint —
  kept separate so append-only snapshots stay immutable; one approval per snapshot, upsert).
- **Read models** (`lib/views/`): `universe` (faceted list + one-liner/conviction from latest
  snapshot), `company` (the full canonical file: identity → fundamentals + diff → Monte Carlo
  scenario → market context → relationships w/ read-through counts → current-events feed → signals →
  history → approval state), `jobs` (pg-boss queue, recent coverage, alert + news feeds).
- **Screens** (App Router server components, `force-dynamic`): `/universe`, `/company/[id]`,
  `/jobs`, `/` → redirect. Shared nav + design tokens (`app/globals.css`).
- **Control surface** (Server Actions, `app/actions.ts`): add company (Ingestion) · run coverage on
  the latest EDGAR report (enqueue) · enroll in analytics pipeline (→ `monitoring`) · enroll in
  content pipeline · approve/edit thesis (checkpoint) · add/verify/delete links.

## The "nested dolls" rendered
The Company screen renders the matryoshka the owner described, top-to-bottom: **the asset → its
fundamentals → our thesis → the Monte Carlo scenario (bands, beat-prob vs consensus, watch-items) →
external consensus/analyst context → its relationships and the read-throughs that traveled them →
its sector**. Sentiment block stubs until Phase 7.

## Testing milestone — 62/62 passing
`tests/console.integration.test.ts` (ephemeral Postgres, seeded canonical file + graph): Universe
lists with one-liner/conviction/link-count + faceting; Company detail assembles the nested snapshot
and a **real read-through relationship** (readthrough_count = 1); the **human checkpoint** is
exercised (an approval with an edit surfaces on the company); Pipeline read models surface recent
coverage + the news feed. Live: all four screens 200 through the auth stack; build clean; the
pg-boss `uuid` cast guarded against legacy placeholder jobs.

## DoD — met
Browse the universe, open a company and read its canonical file + read-throughs, edit links, watch
the pipeline, and approve a thesis — plus the owner's priority: **select an asset → run the initial
coverage on its latest report → enroll it into the automated analytics + content pipelines.**

## Open items (carried forward)
- A dedicated force-directed **Relationships graph** page (Phase 5 ships relationships + read-through
  paths as a table on the Company screen; the graph view is a polish add).
- **Sector** screen = Phase 9, **Calendar** = Phase 6, **Content Library** = Phase 8.
- Sentiment block on the Company screen stubs until Phase 7 (Brand/Sentiment engine).
- Console password is basic-auth single-user; multi-user / real sessions can come later if needed.
