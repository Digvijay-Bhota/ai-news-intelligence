ALTER TABLE articles_raw ADD COLUMN updated_at INTEGER;

UPDATE articles_raw
SET updated_at = COALESCE(fetched_at, created_at, unixepoch())
WHERE updated_at IS NULL;

CREATE TRIGGER IF NOT EXISTS trg_articles_raw_set_updated_at
AFTER INSERT ON articles_raw
FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
  UPDATE articles_raw
  SET updated_at = unixepoch()
  WHERE id = NEW.id;
END;

CREATE UNIQUE INDEX IF NOT EXISTS
idx_article_content_article_raw_id
ON article_content(article_raw_id);

CREATE UNIQUE INDEX IF NOT EXISTS
idx_source_health_source_id
ON source_health(source_id);
