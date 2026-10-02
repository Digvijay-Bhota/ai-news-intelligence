-- Rate limiting needs one row per (identifier, endpoint, window_start).
-- The upsert in workers/src/utils/rate-limiter.ts only increments when this
-- unique key exists; without it every request inserted a new row and the
-- count never rose above 1. Applied to production on 2026-10-02.
-- Safe to re-run: the DELETE finds nothing once duplicates are gone.

DELETE FROM rate_limit_logs
WHERE id NOT IN (
  SELECT MIN(id) FROM rate_limit_logs
  GROUP BY identifier, endpoint, window_start
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rate_limit_unique
ON rate_limit_logs(identifier, endpoint, window_start);
