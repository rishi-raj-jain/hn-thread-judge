-- Hacker News Judge additions. Everything here is additive: nullable columns
-- and indexes only. No existing column or value is modified.

-- Per-comment Jev judgments (written by scripts/judge-threads.ts).
ALTER TABLE items ADD COLUMN IF NOT EXISTS jev_stance text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS jev_substance real;
ALTER TABLE items ADD COLUMN IF NOT EXISTS jev_spice real;
ALTER TABLE items ADD COLUMN IF NOT EXISTS jev_is_question boolean;
ALTER TABLE items ADD COLUMN IF NOT EXISTS jev_stance_conf real;
ALTER TABLE items ADD COLUMN IF NOT EXISTS jev_verdict jsonb;
ALTER TABLE items ADD COLUMN IF NOT EXISTS jev_scored_at timestamptz;

-- Home page browse: threads with >= 6 comments, most-discussed first. The
-- ORDER BY is `descendants DESC, time DESC` (no NULLS LAST) so this partial
-- btree supplies the order directly and only the page's rows are read.
CREATE INDEX IF NOT EXISTS items_story_comments_idx
  ON items (descendants DESC, "time" DESC)
  WHERE type = 'story' AND NOT deleted AND NOT dead AND title IS NOT NULL AND title <> '' AND descendants >= 6;

-- Judged leaderboard: the handful of stories that carry a Jev verdict. The
-- predicate is highly selective, so this tiny partial index answers /judged
-- in well under a millisecond instead of scanning every story.
CREATE INDEX IF NOT EXISTS items_judged_idx
  ON items (descendants DESC)
  WHERE jev_verdict IS NOT NULL;

-- Give the planner statistics on the new, almost-entirely-null columns so it
-- picks items_judged_idx instead of a parallel sequential scan.
ANALYZE items;
