# Phase 0 — Provisioning & Environment (record)

**Status:** ✅ complete — all four health checks green (2026-06-30).
**Host:** owned DigitalOcean droplet, region `sgp1`, Ubuntu 24.04, IP `157.245.158.176`.

## What was provisioned

| Component | Version | Notes |
|---|---|---|
| Node.js | 20.20.2 LTS | NodeSource repo configured |
| PostgreSQL | 16.14 | PGDG repo; cluster `16/main` on :5432 |
| pgvector | 0.8.3 | extension enabled in `investing_together` |
| Caddy | 2.11.4 | reverse proxy `:80 → :3000`, HTTP-only (no TLS yet) |
| Next.js app | (App Router, TS) | minimal hello page + `/api/health` |
| DO Spaces | bucket `it-v1-kb-75b596` (sgp1) | bucket-scoped readwrite key `it-v1-app` |

## Database

- DB `investing_together`, role `it_v1` (login), `pgvector` enabled.
- Connection string in `.env` as `DATABASE_URL` (never committed).

## Secrets (`.env`, root-owned, `chmod 600`, git-ignored)

`ANTHROPIC_API_KEY` · `DATABASE_URL` · `DO_API_TOKEN` · `SPACES_BUCKET` · `SPACES_REGION`
· `SPACES_ENDPOINT` · `SPACES_KEY` · `SPACES_SECRET`. All documented in `.env.example`.

The Spaces app key is **least-privilege** (readwrite, scoped to the one bucket); the temporary
full-access bootstrap key used to create the bucket was deleted.

## Deploy / run

One command: **`bash scripts/deploy.sh`** (pull → `npm ci` → build → sync unit → restart).
The app runs as **`it-v1.service`** (systemd, boot-persistent, restart-on-failure); the unit is
version-controlled at `deploy/it-v1.service`. Caddy and Postgres are also systemd-managed.

## Health check (the testing milestone)

```
node --env-file=.env scripts/health-check.mjs
```
Confirms: (a) Postgres + pgvector, (b) Spaces PUT/GET/DELETE round-trip,
(c) a 1-token Claude API call returns 200, (d) the app serves over HTTP.

```
✓ PASS  a. Postgres + pgvector     pgvector 0.8.3
✓ PASS  b. DO Spaces round-trip    PUT/GET/DELETE ok
✓ PASS  c. Claude API (1 token)    HTTP 200
✓ PASS  d. App over HTTP           http://localhost:80 → HTTP 200
```

## Open items (carried forward, not blockers for Phase 1)

- **TLS deferred.** HTTP-only on the IP for now (owner's choice); needed before Phase 2 webhooks.
- **SSH hardening deferred.** Droplet uses password login; harden (key-based + fail2ban) before public.
- **AWS SDK + Node:** `@aws-sdk/client-s3` v3 will require Node ≥22 after Jan 2027; upgrade Node before then.
