-- Company purge: let an operator fully delete a company (and cascade-remove its append-only
-- snapshots) WITHOUT weakening the append-only guarantee for any normal operation.
--
-- canonical_snapshots is append-only (0003): re-runs append, prior snapshots never mutate/delete.
-- That guard (forbid_mutation) also blocked the ON DELETE CASCADE fired by deleting a company, so a
-- researched company could never be removed. We now allow a DELETE only inside a transaction that
-- has explicitly opted in with `SET LOCAL app.allow_purge = 'on'` — which the deleteCompany server
-- action sets for exactly its delete transaction and nothing else. UPDATE stays forbidden always;
-- an un-flagged DELETE stays forbidden. Transaction-scoped and session-local: no locks, no effect on
-- the concurrent worker, and the moment the delete transaction ends the flag is gone.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_purge', true) = 'on' THEN
    RETURN OLD;  -- authorized company purge (see deleteCompany)
  END IF;
  RAISE EXCEPTION '% is append-only — % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;
