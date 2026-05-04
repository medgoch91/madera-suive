-- 20260504020000_articles_stock_min.sql
-- Add a per-article minimum stock threshold for low-stock Telegram alerts.

BEGIN;

ALTER TABLE articles ADD COLUMN IF NOT EXISTS stock_min NUMERIC NULL;

COMMENT ON COLUMN articles.stock_min IS 'Minimum stock threshold. When articles.stock drops below this value after any decrement (BS save/edit, etc.), the client broadcasts a low-stock notification. NULL = no alert configured.';

COMMIT;
