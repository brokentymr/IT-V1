# Phase 2 — Ingest paths: webhooks & signals (record)

**Status:** ✅ complete — testing milestone green + live verification (2026-06-30).

## Domain & TLS
- **`https://markets.kuramoto.io`** — GoDaddy A record → droplet; Caddy auto-issues + renews a
  Let's Encrypt cert; HTTP→HTTPS redirect. `PUBLIC_BASE_URL` in `.env`; Caddyfile version-controlled
  at `deploy/Caddyfile`.

## What was built
- **Queue/worker** (`lib/queue/`, `scripts/worker.ts`): self-hosted **pg-boss** on the app Postgres;
  worker runs as **`it-v1-worker.service`** (systemd, boot-persistent), subscribed to `coverage-pass`
  (placeholder until Engine 2 / Phase 4).
- **Idempotency** (migration `0005`): `webhook_deliveries` with `UNIQUE(source, idempotency_key)` —
  replays collide and are acknowledged without reprocessing.
- **Webhook cores** (`lib/webhooks/`): verification (HMAC-SHA256 + shared-secret, constant-time),
  company resolution, and two handlers with injectable storage/queue for tests:
  - **TradingView** — shared-secret token in the alert JSON → route by ticker/symbol → `signal_event`
    + provenance. Idempotent on a payload `id` (or a hash of the alert fields).
  - **Filing** — HMAC-signed → archive raw payload to Spaces → `raw_document` + provenance →
    enqueue `coverage-pass`. Idempotent on the filing accession.
- **Routes**: `app/api/webhooks/tradingview` + `/filing` (Next.js, dynamic).

## Testing milestone (the gate) — 35/35 passing

Unit: HMAC + shared-secret verification. Integration (ephemeral Postgres + fake queue/store):
valid **and** bad-signature **and** idempotent-replay for both webhooks; asserts rows written,
bad ones rejected, the coverage-pass job enqueued, and no double-writes.

```
Test Files  6 passed (6)     Tests  35 passed (35)
```

## Live verification (real DB, over HTTPS)

| Request | Result |
|---|---|
| `POST /api/webhooks/tradingview` (valid secret, AAPL) | `200 ok`, signal_event written |
| same with bad secret | `401 unauthorized`, nothing written |
| `POST /api/webhooks/filing` (valid HMAC) | `200 ok`, raw_document + Spaces archive + job enqueued |
| same with bad signature | `401 unauthorized`, nothing written |

Worker picked up the `coverage-pass` job; filing archived to Spaces (`filings/<accession>.json`).

## DoD — met
Both webhook paths verified end-to-end on the droplet; signed, idempotent, provenance-stamped; the
coverage-pass trigger fires into pg-boss and the worker consumes it. **Remaining for full DoD:** a
live TradingView alert from the owner's account (handoff below).

## TradingView setup (URL-secret + OHLCV) — live-confirmed
Secret lives in the **URL path** so the message is pure data:
- **Webhook URL:** `https://markets.kuramoto.io/api/webhooks/tradingview/<TRADINGVIEW_WEBHOOK_SECRET>`
- **Message:**
```json
{"symbol":"{{ticker}}","tf":"{{interval}}","o":{{open}},"h":{{high}},"l":{{low}},"c":{{close}},"v":{{volume}},"t":"{{time}}"}
```
Captures full OHLCV per candle into `signal_events.payload.ohlc`. Symbols in the universe attach to
their company; others (e.g. `NQ!` futures) are retained unrouted (`company_id` null). `{{time}}` is
parsed as epoch-millis. The body-secret form is still accepted for back-compat. **Verified live**
with a real NQ 3-minute alert landing over HTTPS (2026-06-30).

## Open items (carried forward)
- TradingView has no HMAC; auth is the shared-secret token (rotate by regenerating the env value).
- The Next (sender) and worker each start a pg-boss instance; could set the sender to `supervise:false`.
- `signal_event` is the authoritative signal record; the §3.4 snapshot `signals` block is assembled
  from it when a snapshot exists (Engine 2, Phase 4).
