-- Migration 0015: index article_events by event_id
--
-- article_events has PRIMARY KEY (article_raw_id, event_id), so lookups by
-- event_id alone cannot use the primary key. The active-events queries in
-- workers/src/db/client.ts join `LEFT JOIN article_events ae ON e.id =
-- ae.event_id`; without this index SQLite scans article_events once per event.
--
-- d1/schema.sql has defined this index since 2026-09-02, but no migration
-- created it, so databases created before then (including production) lack it.
-- Same definition as d1/schema.sql. IF NOT EXISTS makes it safe to re-run and a
-- no-op on databases built from the current schema.sql.
-- Not applied to production by this change.

CREATE INDEX IF NOT EXISTS idx_article_events_event_id ON article_events(event_id);
