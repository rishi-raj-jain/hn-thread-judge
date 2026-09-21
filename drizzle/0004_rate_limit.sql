-- Per-IP daily quota for on-demand thread judging (POST /api/judge/:id).
-- Additive: a standalone table, no existing column or value is touched. One row
-- per (ip, day) holds the count of new judges that IP has spent that day. The
-- primary key keeps the reserve upsert atomic. Old days are harmless.
CREATE TABLE IF NOT EXISTS judge_rate_limit (
  ip    text    NOT NULL,
  day   date    NOT NULL DEFAULT current_date,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, day)
);
