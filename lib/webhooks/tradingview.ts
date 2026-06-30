import { randomUUID } from "node:crypto";
import { withTransaction } from "../db/pool";
import { verifySharedSecret, sha256Hex } from "./verify";
import { resolveCompanyId } from "./resolve";
import type { WebhookStatus } from "./types";

export interface TradingViewResult {
  status: WebhookStatus;
  signal_event_id?: string;
  company_id?: string | null;
  symbol?: string | null;
  routed?: boolean; // true if the symbol mapped to a covered company
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Process a TradingView alert (spec §4.1 signal path).
 *
 * Auth is a shared-secret token supplied in the URL path (preferred — nothing in the message)
 * or, for back-compat, a `secret` field in the body. Captures OHLCV for the candle period,
 * routes to a company when the symbol is in the universe, and otherwise stores the signal
 * unrouted so index/futures data (e.g. NQ!) is retained. Idempotent per candle.
 */
export async function processTradingViewWebhook(rawBody: string, urlSecret?: string): Promise<TradingViewResult> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: "bad_request" };
  }

  const secret = process.env.TRADINGVIEW_WEBHOOK_SECRET;
  const provided = (urlSecret ?? (typeof payload.secret === "string" ? payload.secret : "")).trim();
  if (!secret || !verifySharedSecret(provided, secret)) {
    console.warn(`[tradingview] unauthorized — provided length=${provided.length}, expected=${secret?.length ?? 0}`);
    return { status: "unauthorized" };
  }

  const symbol = str(payload.symbol) ?? str(payload.tradingview_symbol) ?? str(payload.ticker);
  const ticker = str(payload.ticker);
  if (!symbol && !ticker) return { status: "bad_request" };

  const rawTime =
    typeof payload.t === "string" ? payload.t : typeof payload.time === "string" ? payload.time : null;
  const parsed = rawTime ? new Date(rawTime) : null;
  const ts = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();

  const timeframe = str(payload.tf) ?? str(payload.timeframe);
  const ohlc = {
    open: num(payload.o ?? payload.open),
    high: num(payload.h ?? payload.high),
    low: num(payload.l ?? payload.low),
    close: num(payload.c ?? payload.close ?? payload.price),
    volume: num(payload.v ?? payload.volume),
  };

  const idemKey =
    typeof payload.id === "string" && payload.id
      ? payload.id
      : sha256Hex([symbol ?? ticker, timeframe, ts].join("|"));

  return withTransaction(async (client): Promise<TradingViewResult> => {
    const companyId = await resolveCompanyId(client, { ticker, symbol });

    const delivered = await client.query(
      `INSERT INTO webhook_deliveries (source, idempotency_key, company_id, payload)
       VALUES ('tradingview', $1, $2, $3) ON CONFLICT (source, idempotency_key) DO NOTHING RETURNING id`,
      [idemKey, companyId, payload],
    );
    if (delivered.rowCount === 0) {
      return { status: "duplicate", company_id: companyId, symbol, routed: !!companyId };
    }

    const eventId = randomUUID();
    await client.query(
      `INSERT INTO signal_events (id, company_id, ts, kind, symbol, payload)
       VALUES ($1, $2, $3, 'tradingview_alert', $4, $5)`,
      [eventId, companyId, ts, symbol, {
        symbol, ticker, timeframe, ohlc,
        indicator: payload.indicator ?? null,
        signal: payload.signal ?? null,
        price: ohlc.close,
        note: payload.note ?? null,
      }],
    );
    // Provenance only when the signal is attached to a covered company.
    if (companyId) {
      await client.query(
        `INSERT INTO sources (company_id, tier, kind, origin, title, retrieved_at, metadata)
         VALUES ($1, 1, 'tradingview_alert', 'TradingView', $2, now(), $3)`,
        [companyId, `${symbol ?? ticker} ${timeframe ?? ""}`.trim(), { idempotency_key: idemKey }],
      );
    }
    return { status: "ok", signal_event_id: eventId, company_id: companyId, symbol, routed: !!companyId };
  });
}
