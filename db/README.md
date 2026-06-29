# Knowledge base schema

The proprietary core (section 2). Self-hosted Postgres + pgvector. Tables map
directly to the authoritative data model in section 3 and the application data
model in section 7.2.

## Migrations

Applied in lexical order by `scripts/migrate.ts`, each once, tracked in
`schema_migrations`.

```bash
cp .env.example .env        # set DATABASE_URL
npm install
npm run db:migrate          # apply pending migrations
npm run db:reset            # DEV ONLY: drop public schema, re-apply all
```

| File | Spec | Contents |
|---|---|---|
| `0001_extensions.sql` | 7.1 | pgcrypto, pgvector, `set_updated_at()` |
| `0002_enums.sql` | 3 | all enums; rubric **bands are NOT enums** (config, 4.3) |
| `0003_taxonomy_and_markets.sql` | 3.1, 3.2 | `gics_classifications`, `markets` |
| `0004_companies.sql` | 3.3 | `companies` (atomic node) + `company_markets` |
| `0005_raw_landing_zone.sql` | 2, 3.7, 8 | `raw_documents` (Tier 1), `sources` (provenance) |
| `0006_company_links.sql` | 3.8 | `company_links` (the relationship graph) |
| `0007_canonical_files.sql` | 3.4 | `canonical_files` + append-only `canonical_snapshots` |
| `0008_news_notes.sql` | 3.6 | `news_notes` (primary + read_through) |
| `0009_signal_events.sql` | 3.7 | `signal_events` (webhook path) |
| `0010_cohort_and_content.sql` | 3.5, 6.1, 7.2 | `cohort_reports`, `content_items` |

`jobs` is owned by **pg-boss** (7.1) and created in its own schema by the queue
library at runtime — not migrated here.

## Design notes

- **Storage is a faceted graph; navigation is a hierarchy.** The company is the
  atomic node; sector/market are facets denormalized onto it; relationships
  live as typed edges in `company_links`.
- **Canonical file = JSONB document + append-only snapshots.** Heavy engine
  output is stored as JSONB exactly per the 3.4 sub-schemas; queryable fields
  (`as_of`, `cycle_label`, `trigger`, `conviction`) are promoted to columns.
  Re-runs append a new snapshot and never corrupt a prior one (4.5).
- **Importance is a raw 0-100 integer.** The band (low/material/major) and the
  action are derived from `src/config/rubric.ts`, never stored, so thresholds
  tune without a rebuild (4.3).
- **Provenance is first-class.** Every material claim references a `sources`
  row that points back to a Tier-1 `raw_document` (section 8).
