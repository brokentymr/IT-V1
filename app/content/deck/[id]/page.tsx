import { notFound } from "next/navigation";
import { getContentItem } from "../../../../lib/content/store";
import DeckViewer from "./DeckViewer";
import type { Deck } from "../../../../lib/engines/deck";

export const dynamic = "force-dynamic";

export default async function DeckPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const item = await getContentItem(id);
  if (!item || item.type !== "deck") notFound();
  return <DeckViewer deck={item.body as Deck} id={id} />;
}
