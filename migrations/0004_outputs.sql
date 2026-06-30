-- Output consumables (§6) and the semantic-search corpus.

-- §3.5 sector cohort files / reports.
CREATE TABLE cohort_reports (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope      jsonb NOT NULL,                 -- §3.5 scope {gics_level, value, markets[]}
  as_of      date NOT NULL,
  content    jsonb NOT NULL DEFAULT '{}',    -- comparative / positioning / sector_thesis / provenance
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cohort_reports_asof_idx ON cohort_reports(as_of DESC);

-- §6 content artifacts: memo, sector report, podcast script, short-form pack, newsletter.
CREATE TABLE content_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
  cohort_id  uuid REFERENCES cohort_reports(id) ON DELETE CASCADE,
  type       text NOT NULL,                  -- company_memo | sector_report | podcast_script | shortform_pack | newsletter
  format     text NOT NULL,                  -- html | pdf | markdown | json | doc
  audience   text,                           -- internal | audience | production
  body       jsonb NOT NULL DEFAULT '{}',    -- rendered structure / payload
  metadata   jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX content_items_company_idx ON content_items(company_id);
CREATE INDEX content_items_type_idx ON content_items(type);

-- pgvector semantic-search corpus. Embedding dimension + ANN index are added in the phase that
-- wires the embedding model (Claude has no embeddings API, so the model is TBD); kept unspecified
-- here so we don't bake in a wrong dimension. Foundation only.
CREATE TABLE corpus_embeddings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid REFERENCES companies(id) ON DELETE CASCADE,
  source_ref  uuid REFERENCES sources(id) ON DELETE SET NULL,
  raw_document_id uuid REFERENCES raw_documents(id) ON DELETE CASCADE,
  chunk_index int NOT NULL DEFAULT 0,
  chunk_text  text NOT NULL,
  embedding   vector,                        -- dimension set when the embedding model is chosen
  metadata    jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX corpus_embeddings_company_idx ON corpus_embeddings(company_id);
