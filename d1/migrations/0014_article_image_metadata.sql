-- Migration 0014: Optional article image metadata (Phase 2)
--
-- Adds nullable image_url and image_credit columns to articles_raw. Values are
-- written during RSS ingestion only for sources with an approved exact image
-- host (workers/src/utils/image-hosts.ts), and are re-validated every time an
-- API response is built. No defaults, no index, no backfill: existing rows
-- keep NULL in both columns.
--
-- Apply ONCE, and only to an existing database created before this migration.
-- Databases created from the current d1/schema.sql already have both columns:
-- do NOT apply this file on top of it. ALTER TABLE ... ADD COLUMN is not
-- repeatable and fails with "duplicate column name" if a column exists.
-- Apply it BEFORE deploying Worker code that writes these columns.
-- Full procedure (check, apply once, verify, rollback): README.md, section
-- "Migration 0014: article image metadata".
-- Not applied to production by this change.

ALTER TABLE articles_raw ADD COLUMN image_url TEXT;
ALTER TABLE articles_raw ADD COLUMN image_credit TEXT;
