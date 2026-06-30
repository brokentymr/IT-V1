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

export async function POST(req: Request) {
  const body = await req.text();
  const result = await processTradingViewWebhook(body);
  return NextResponse.json(result, { status: STATUS_CODE[result.status] ?? 500 });
}
