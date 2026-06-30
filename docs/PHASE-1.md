# Phase 1 — Schema & Knowledge-Base Foundation + Engine 1 (record)

**Status:** ✅ complete — testing milestone green (2026-06-30).

## What was built

- **Migration runner** (`lib/db/migrate.ts`, `npm run migrate`): ordered, idempotent SQL files
  tracked in `schema_migrations`, each in its own transaction.
- **Schema** (`migrations/0001–0004`): the §7.2 tables — `sectors` (GICS), `markets`, `companies`,
  `company_links` (relationship graph), `canonical_files` + **append-only** `canonical_snapshots`
  (DB trigger blocks UPDATE/DELETE), `news_notes`, `signal_events`, `raw_documents`, `sources`
  (provenance), `cohort_reports`, `content_items`, `corpus_embeddings` (pgvector). 13 tables.
- **Type contract** (`lib/types.ts`): zod schemas + inferred TS types for the normative §3 shapes;
  the runtime enforcement of "DB shapes match §3 exactly". `tsc --noEmit` is clean.
- **GICS** (`lib/gics/`): taxonomy seed (11 sectors + 25 industry groups) + a SIC→GICS crosswalk
  (`classifyFromSic`). Phase-1 decision: classify from free SEC SIC to sector/group; industry &
  sub-industry are deferred (null) with a recorded `classification_confidence`.
- **Adapters**: `lib/storage/spaces.ts` (DO Spaces put/get/delete) and `lib/sources/sec.ts`
  (SEC EDGAR, behind the isolated `SourceResult` interface with graceful degradation + provenance;
  injectable fetcher for fixture-based tests).
- **Engine 1 — Ingestion/Identity** (`lib/engines/ingestion.ts`, `npm run ingest -- <TICKER>`):
  ticker → SEC identity → GICS classification → company record + canonical skeleton + provenance
  source + seeded `thematic_peer` links to same-group companies + confidence/missing-sources.
  Deterministic (no LLM) — $0 against the ceiling. Idempotent on ticker.

## Testing milestone (the gate) — 25/25 passing

- **Unit**: SIC→GICS crosswalk (incl. boundary + fallback + unknown), §3 zod conformance
  (valid/invalid/defaults), SEC adapter against fixtures (resolve, degrade, identity).
- **Integration** (ephemeral Postgres + recorded SEC fixtures, no live APIs): migrate → seed GICS →
  ingest AAPL → assert company + skeleton + provenance + GICS path; ingest HPQ → assert
  bidirectional peer links; re-ingest AAPL → assert idempotent update, no duplicate.

```
Test Files  4 passed (4)     Tests  25 passed (25)
```

Live demo against the real DB: `AAPL` and `HPQ` both classified Information Technology /
Technology Hardware & Equipment (conf 0.9), peer-linked, each with a canonical skeleton and SEC
provenance.

## DoD — met

Schema applies cleanly + idempotently; Engine 1 adds a classified company with seeded links;
types/DB shapes match §3 (zod + `tsc` clean).

## Open items (carried forward)

- **GICS depth**: industry + sub-industry levels are unseeded/unclassified under SIC; revisit when a
  classifier that reaches them is added (a commercial source, a later phase).
- **`corpus_embeddings`** has no fixed vector dimension or ANN index yet — added when the embedding
  model is chosen (Claude has no embeddings API).
- Source rows are written per fetch (not deduped) — provenance is per-retrieval by design.
