-- 0001_extensions.sql
-- Foundational extensions for the knowledge base.
-- pgcrypto: gen_random_uuid() for primary keys.
-- vector (pgvector): semantic search across the corpus (section 7.1).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- updated_at trigger helper, reused across tables.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
