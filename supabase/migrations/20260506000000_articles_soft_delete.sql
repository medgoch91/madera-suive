-- 20260506000000_articles_soft_delete.sql
-- Articles cannot be hard-deleted once they're referenced by bons_sortie_lines
-- (FK blocks). User feedback: trying to delete a no-longer-needed article
-- raises "violates foreign key constraint bons_sortie_lines_article_id_fkey".
--
-- Switch articles to the soft-delete pattern already in use by bons / cheques /
-- factures / chantiers: set deleted_at = NOW() instead of removing the row.
-- BS lines snapshot the article name at save time (snapshot_name) so history
-- stays readable even after the article is hidden from the live catalog.

BEGIN;

ALTER TABLE articles ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN articles.deleted_at IS 'Soft-delete marker. Loaders filter on deleted_at IS NULL. NULL = visible. Non-NULL = archived; FK references in bons_sortie_lines, bons.lignes (jsonb), etc. remain intact.';

CREATE INDEX IF NOT EXISTS idx_articles_deleted_at ON articles(deleted_at) WHERE deleted_at IS NOT NULL;

COMMIT;
