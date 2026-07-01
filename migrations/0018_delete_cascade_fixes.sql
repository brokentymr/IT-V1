-- Delete/wipe cascade fixes (found while re-running Micron through the upgraded pipeline).
--
-- (1) news_notes.source_ref was NO ACTION, so deleting a company FAILED whenever one of its news notes
--     referenced a `sources` row being cascade-deleted (the TSM delete error:
--     "news_notes_source_ref_fkey"). A source disappearing should NULL the note's pointer, not block the
--     delete. SET NULL also makes cross-company read-through notes safe: deleting company B nulls the
--     dangling source pointer on a surviving company-A note instead of erroring.
ALTER TABLE news_notes DROP CONSTRAINT news_notes_source_ref_fkey;
ALTER TABLE news_notes ADD CONSTRAINT news_notes_source_ref_fkey
  FOREIGN KEY (source_ref) REFERENCES sources(id) ON DELETE SET NULL;

-- (2) webhook_deliveries.company_id was SET NULL, so deleting a company left ORPHANED filing-delivery
--     rows whose idempotency keys (the filing accessions) survived. On re-adding the same name, the
--     coverage pass's "claim this accession" INSERT hit those stale keys (ON CONFLICT DO NOTHING) and
--     silently skipped coverage — the re-added company produced no snapshot. Cascade the deliveries with
--     the company so a deleted+re-added name can be covered fresh.
ALTER TABLE webhook_deliveries DROP CONSTRAINT webhook_deliveries_company_id_fkey;
ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_company_id_fkey
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
