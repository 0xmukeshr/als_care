-- Enable the pgvector extension
create extension if not exists vector;

-- Create the information chunks table
CREATE TABLE site_page (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    url TEXT,
    chunk_number INTEGER,
    title TEXT,
    summary TEXT,
    content TEXT,
    metadata JSONB,
    embedding VECTOR(1536)
);

BEGIN;
SET LOCAL maintenance_work_mem = '64MB';
CREATE INDEX ON site_page USING ivfflat (embedding vector_cosine_ops);
COMMIT;

-- Create an index for better vector similarity search performance
create index on site_page using ivfflat (embedding vector_cosine_ops);

-- Create an index on metadata for faster filtering
create index idx_site_pages_metadata on site_page using gin (metadata);

-- Create a function to search for information chunks
CREATE OR REPLACE FUNCTION match_site_pages (
  query_embedding vector(1536),
  match_count int default 10,
  filter jsonb 
) RETURNS TABLE (
    id UUID
    url TEXT,           -- Add this line to include the url column
    chunk_number INTEGER,
    title TEXT,
    summary TEXT,
    content TEXT,
    metadata JSONB,
    similarity float
)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT
    id,
    url,
    chunk_number,
    title,
    summary,
    content,
    metadata,
    1 - (site_page.embedding <=> query_embedding) AS similarity
  FROM site_page
  WHERE metadata @> filter
  ORDER BY site_page.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Everything above will work for any PostgreSQL database. The below commands are for Supabase security

-- Enable RLS on the table
alter table site_page enable row level security;

-- Create a policy that allows anyone to read
create policy "Allow public read access"
  on site_page
  for select
  to public
  using (true);