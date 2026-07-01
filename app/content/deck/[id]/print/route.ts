import { getContentItem } from "../../../../../lib/content/store";
import { deckHtml } from "../../../../../lib/content/render";
import type { Deck } from "../../../../../lib/engines/deck";

export const dynamic = "force-dynamic";

// Standalone printable HTML — one color-coded slide per page. Browser "Print → Save as PDF" (or a
// headless print) produces the memo's PDF form.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const item = await getContentItem(id);
  if (!item || item.type !== "deck") return new Response("Not found", { status: 404 });
  return new Response(deckHtml(item.body as Deck), { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
