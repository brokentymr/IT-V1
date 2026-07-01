import { notFound } from "next/navigation";
import { buildConsumerView } from "../../../lib/views/consumer";
import { query } from "../../../lib/db/pool";
import ConsumerDeck from "./ConsumerDeck";

export const dynamic = "force-dynamic";

export default async function ConsumerCompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await buildConsumerView(id);
  if (!view) notFound();
  const deck = await query<{ id: string }>(
    "SELECT id FROM content_items WHERE company_id = $1 AND type = 'deck' ORDER BY created_at DESC LIMIT 1", [id],
  );
  return (
    <ConsumerDeck
      id={view.id} ticker={view.ticker} legal_name={view.legal_name}
      status={view.status} building={view.building} progress={view.progress}
      deckId={deck.rows[0]?.id ?? null} cards={view.cards}
    />
  );
}
