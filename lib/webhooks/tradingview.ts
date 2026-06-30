import { randomUUID } from "node:crypto";
import { withTransaction } from "../db/pool";
import { verifySharedSecret, sha256Hex } from "./verify";
import { resolveCompanyId } from "./resolve";
import type { WebhookStatus } from "./types";

export interface TradingViewResult {
  status: WebhookStatus;
  signal_event_id?: string;
  company_id?: string;
}

/**
 * Process a TradingView alert (spec §4.1 signal path). Authenticates via a shared-secret
 * token in the JSON payload, routes by ticker / tradingview_symbol, writes a signal_event
 * + provenance, and is idempotent on (source, idempotency_key).
 */
export async function processTradingViewWebhook(rawBody: string): Promise<TradingViewResult> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: "bad_request" };
  }

  const secret = process.env.TRADINGVIEW_WEBHOOK_SECRET;
  if (!secret || !verifySharedSecret(payload.secret, secret)) return { status: "unauthorized" };

  const ticker = typeof payload.ticker === "string" ? payload.ticker : null;
  const symbol =
    typeof payload.symbol === "string"
      ? payload.symbol
      : typeof payload.tradingview_symbol === "string"
        ? payload.tradingview_symbol
        : null;
  if (!ticker && !symbol) return { status: "bad_request" };

  const ts = typeof payload.time === "string" ? payload.time : new Date().toISOString();
  const idemKey =
    typeof payload.id === "string" && payload.id
      ? payload.id
      : sha256Hex([symbol ?? ticker, payload.indicator, payload.signal, payload.timeframe, ts].join("|"));

  return withTransaction(async (client) => {
    const companyId = await resolveCompanyId(client, { ticker, symbol });
    if (!companyId) return { status: "unknown_company" as WebhookStatus };

    const delivered = await client.query(
      `INSERT INTO webhook_deliveries (source, idempotency_key, company_id, payload)
       VALUES ('tradingview', $1, $2, $3) ON CONFLICT (source, idempotency_key) DO NOTHING RETURNING id`,
      [idemKey, companyId, payload],
    );
    if (delivered.rowCount === 0) return { status: "duplicate", company_id: companyId };

    const eventId = randomUUID();
    await client.query(
      `INSERT INTO signal_events (id, company_id, ts, kind, payload)
       VALUES ($1, $2, $3, 'tradingview_alert', $4)`,
      [eventId, companyId, ts, {
        indicator: payload.indicator ?? null,
        signal: payload.signal ?? null,
        timeframe: payload.timeframe ?? null,
        price: payload.price ?? null,
        note: payload.note ?? null,
        symbol: symbol ?? null,
        ticker: ticker ?? null,
      }],
    );
    await client.query(
      `INSERT INTO sources (company_id, tier, kind, origin, title, retrieved_at, metadata)
       VALUES ($1, 1, 'tradingview_alert', 'TradingView', $2, now(), $3)`,
      [companyId, `${payload.indicator ?? "alert"} ${payload.signal ?? ""}`.trim(), { idempotency_key: idemKey }],
    );
    await client.query(
      `UPDATE webhook_deliveries SET result = $2 WHERE source = 'tradingview' AND idempotency_key = $1`,
      [idemKey, { signal_event_id: eventId }],
    );
    return { status: "ok", signal_event_id: eventId, company_id: companyId };
  });
}
