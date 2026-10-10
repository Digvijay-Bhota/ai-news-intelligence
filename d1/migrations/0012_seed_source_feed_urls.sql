-- Backfill feed URLs for the starter sources seeded by schema.sql.
-- Earlier seeds inserted these rows without feed_url, and the fetcher skips
-- sources that have none. Only empty or NULL feed URLs are filled; a feed URL
-- someone has already set is left alone. Safe to re-run.
--
-- URLs come from the publishers:
--   TechCrunch: https://techcrunch.com/rss-terms-of-use/ links "/feed/"
--   The Verge:  https://www.theverge.com/ declares /rss/index.xml as its RSS alternate
-- Ars Technica is not included: its feed URL could not be verified from the publisher.

UPDATE sources
SET feed_url = 'https://techcrunch.com/feed/', updated_at = unixepoch()
WHERE name = 'TechCrunch' AND (feed_url IS NULL OR TRIM(feed_url) = '');

UPDATE sources
SET feed_url = 'https://www.theverge.com/rss/index.xml', updated_at = unixepoch()
WHERE name = 'The Verge' AND (feed_url IS NULL OR TRIM(feed_url) = '');
