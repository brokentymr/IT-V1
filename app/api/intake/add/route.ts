import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { addResolvedEntity, ResolvedEntity } from "../../../../lib/engines/intake";

/** Add the operator-selected entities (auto-runs initial research per the owner's decision). */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const entities = Array.isArray(body.entities) ? body.entities : [];
  const research_focus = Array.isArray(body.research_focus) ? body.research_focus.filter((x: unknown) => typeof x === "string") : [];
  const results = [];
  for (const e of entities) {
    const parsed = ResolvedEntity.safeParse(e);
    if (!parsed.success) { results.push({ name: (e as { name?: string })?.name ?? "?", result: "failed", detail: "invalid entity" }); continue; }
    try {
      results.push(await addResolvedEntity(parsed.data, { autoRun: true, research_focus }));
    } catch (err) {
      results.push({ name: parsed.data.name, result: "failed", detail: (err as Error).message.slice(0, 120) });
    }
  }
  revalidatePath("/universe");
  return NextResponse.json({ results });
}
