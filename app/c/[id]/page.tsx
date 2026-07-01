import { notFound } from "next/navigation";
import { buildConsumerView } from "../../../lib/views/consumer";
import { query } from "../../../lib/db/pool";
import ConsumerDeck from "./ConsumerDeck";

export const dynamic = "force-dynamic";

export default async function ConsumerCompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await buildConsumerView(id);
  if (!view) notFound();
  // Deck link is gated on the SAME publish signal as the cards, and pinned to the shown snapshot — a
  // stale approved deck from a prior snapshot must not leak through when the latest is unvetted.
  const deck = view.show_thesis && view.snapshot_id
    ? await query<{ id: string }>(
        "SELECT id FROM content_items WHERE company_id = $1 AND snapshot_id = $2 AND type = 'deck' AND suppressed = false ORDER BY created_at DESC LIMIT 1", [id, view.snapshot_id],
      )
    : { rows: [] };
  return (
    <ConsumerDeck
      id={view.id} ticker={view.ticker} legal_name={view.legal_name}
      status={view.status} building={view.building} progress={view.progress}
      deckId={deck.rows[0]?.id ?? null} cards={view.cards}
      confidence={view.confidence} disclosure={view.disclosure}
    />
  );
}
