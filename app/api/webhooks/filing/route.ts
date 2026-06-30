import { NextResponse } from "next/server";
import { processFilingWebhook } from "@/lib/webhooks/filing";
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
  const signature = req.headers.get("x-signature") ?? req.headers.get("x-hub-signature-256");
  const result = await processFilingWebhook(body, signature);
  return NextResponse.json(result, { status: STATUS_CODE[result.status] ?? 500 });
}
