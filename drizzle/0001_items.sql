CREATE TABLE IF NOT EXISTS items (
  id bigint PRIMARY KEY,
  deleted boolean NOT NULL DEFAULT false,
  type text NOT NULL,
  "by" text,
  time timestamptz,
  text text,
  dead boolean NOT NULL DEFAULT false,
  parent bigint,
  poll bigint,
  kids bigint[] NOT NULL DEFAULT '{}'::bigint[],
  url text,
  score integer,
  title text,
  parts bigint[] NOT NULL DEFAULT '{}'::bigint[],
  descendants integer,
  search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'english',
      coalesce(title, '') || ' ' || coalesce("by", '') || ' ' ||
      coalesce(regexp_replace(text, '<[^>]+>', ' ', 'g'), '')
    )
  ) STORED,
  CONSTRAINT items_type_check CHECK (type IN ('story', 'comment', 'poll', 'pollopt', 'job'))
);

CREATE INDEX IF NOT EXISTS items_type_time_idx ON items (type, time DESC);
CREATE INDEX IF NOT EXISTS items_type_score_idx ON items (type, score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS items_parent_idx ON items (parent);
CREATE INDEX IF NOT EXISTS items_by_time_idx ON items ("by", time DESC);
CREATE INDEX IF NOT EXISTS items_title_trgm_idx ON items USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS items_by_trgm_idx ON items USING gin ("by" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS items_story_new_idx ON items (time DESC)
  WHERE type = 'story' AND NOT deleted AND NOT dead AND title IS NOT NULL AND title <> '';
CREATE INDEX IF NOT EXISTS items_titled_time_idx ON items (time DESC)
  WHERE NOT deleted AND NOT dead AND title IS NOT NULL AND title <> '';
-- Boolean full-text matching for exact counts: a GIN bitmap scan intersects the
-- per-term posting lists, so multi-word (tsquery AND) counts stay exact and fast.
CREATE INDEX IF NOT EXISTS items_search_gin ON items USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS items_search_bm25 ON items USING lakebase_bm25 (search_tsv);
-- Per-type partial BM25 indexes. Their predicates match the app's WHERE clauses
-- so ranking and exact counts run over one type instead of being truncated by
-- the shared index's candidate limit (lakebase_bm25.default_limit).
CREATE INDEX IF NOT EXISTS items_story_bm25 ON items USING lakebase_bm25 (search_tsv)
  WHERE type = 'story' AND NOT deleted AND NOT dead;
CREATE INDEX IF NOT EXISTS items_comment_bm25 ON items USING lakebase_bm25 (search_tsv)
  WHERE type = 'comment' AND NOT deleted AND NOT dead;
CREATE INDEX IF NOT EXISTS items_job_bm25 ON items USING lakebase_bm25 (search_tsv)
  WHERE type = 'job' AND NOT deleted AND NOT dead;
