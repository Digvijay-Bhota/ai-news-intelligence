-- The retry query in listRetryableFailedArticles looks up ai_jobs per article.
-- Without this index it scanned the whole table for every failed article and
-- used up D1's free daily read limit. Applied to production on 2026-10-07.
CREATE INDEX IF NOT EXISTS idx_ai_jobs_article_job
ON ai_jobs(article_raw_id, job_type, status, created_at);
