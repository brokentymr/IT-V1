import { NextRequest, NextResponse } from "next/server";
import { resolveEntities } from "../../../../lib/engines/intake";

/** Resolve free-text intent → proposed entities (the agent's suggestion, not yet added). */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return NextResponse.json({ entities: [], error: "empty input" }, { status: 400 });
  const r = await resolveEntities(text);
  return NextResponse.json(r);
}
