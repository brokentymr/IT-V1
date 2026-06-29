# Investing Together

An agentic research-and-content platform built on an owned, proprietary
knowledge base. Raw materials flow in, are processed into proprietary reports
and outputs, and are rendered for an everyday, family-friendly investing
audience.

> Research is performed **once** per company per cycle and stored in a
> canonical, versioned object. Every output — memo, sector report, podcast
> script, short-form pack, newsletter — is a transformation of that object.
> No output performs its own research.

## Where this is

This is **build-order step 1** (section 9 of the architecture spec): the
foundation everything else depends on.

- ✅ Postgres schema for the knowledge base, raw landing zone, and the
  relationship graph (`company_links`) — see [`db/`](db/README.md).
- ✅ The TypeScript type contract mirroring section 3 — see
  [`src/types/`](src/types/index.ts).
- ✅ Importance-rubric + read-through configuration (4.3 / 4.6, kept as config
  not code) — see [`src/config/rubric.ts`](src/config/rubric.ts).
- ✅ A dependency-free migration runner — see [`scripts/migrate.ts`](scripts/migrate.ts).

Still to come (build order 2–9): webhook ingest, the eight agent engines, the
plain-language layer, and the app screens.

## Stack (owned, on DigitalOcean — section 7.1)

| Concern | Choice |
|---|---|
| Database | Self-hosted Postgres + pgvector (the proprietary knowledge base) |
| Raw blob storage | DO Spaces (S3-compatible) |
| App | Next.js (Node) behind Nginx/Caddy |
| Orchestration | pg-boss (Postgres-backed) + Node worker + cron |
| Agent reasoning | Claude API (the only required external runtime) |

## Getting started

```bash
cp .env.example .env        # set DATABASE_URL et al.
npm install
npm run typecheck
npm run db:migrate
```

## Layout

```
db/migrations/   Postgres schema (section 3 / 7.2), applied in order
scripts/         migration runner
src/types/       authoritative TypeScript contract (section 3)
src/config/      rubric + read-through thresholds (4.3 / 4.6)
src/db/          Postgres connection pool
```
