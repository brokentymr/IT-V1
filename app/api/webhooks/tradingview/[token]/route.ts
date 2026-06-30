import { NextResponse } from "next/server";
import { processTradingViewWebhook } from "@/lib/webhooks/tradingview";
import type { WebhookStatus } from "@/lib/webhooks/types";

export const dynamic = "force-dynamic";

const STATUS_CODE: Record<WebhookStatus, number> = {
  ok: 200,
  duplicate: 200,
  unauthorized: 401,
  unknown_company: 404,
  bad_request: 400,
};

// Secret is in the URL path: https://markets.kuramoto.io/api/webhooks/tradingview/<token>
// The alert message body is pure OHLC data — no secret to fiddle with.
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const body = await req.text();
  const result = await processTradingViewWebhook(body, token);
  return NextResponse.json(result, { status: STATUS_CODE[result.status] ?? 500 });
}
