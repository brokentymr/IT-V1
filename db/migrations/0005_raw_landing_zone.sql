-- 0005_raw_landing_zone.sql
-- TIER 1 — the immutable, as-received, provenance-stamped raw landing zone
-- (section 2), plus the provenance registry (section 8) that every downstream
-- claim links back to.
--
-- Blobs (raw PDFs/HTML, audio) live in object storage (DO Spaces); these rows
-- hold metadata and the Spaces object key.

-- raw_document (3.7): one row per raw item landed in Tier 1.
CREATE TABLE raw_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid REFERENCES companies (id) ON DELETE SET NULL,
  kind         raw_document_kind NOT NULL,     -- filing | transcript | research | news | other
  received_at  timestamptz NOT NULL DEFAULT now(),
  source       text,                            -- where it came from (SEC EDGAR, MT Newswires, upload, ...)
  blob_ref     text,                            -- DO Spaces object key (null for purely structured items)
  metadata     jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_raw_documents_company ON raw_documents (company_id);
CREATE INDEX idx_raw_documents_kind ON raw_documents (kind);
CREATE INDEX idx_raw_documents_received ON raw_documents (received_at);

-- sources (7.2): provenance registry. Every material claim in every consumable
-- links to a Tier-1 source (section 8). A source points at a raw_document and/or
-- an external locator (e.g. a specific filing URL + anchor).
CREATE TABLE sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_document_id uuid REFERENCES raw_documents (id) ON DELETE SET NULL,
  url             text,
  locator         text,                          -- page/section/anchor within the source
  excerpt         text,                          -- the cited text, captured as the agent works
  retrieved_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sources_raw_document ON sources (raw_document_id);
