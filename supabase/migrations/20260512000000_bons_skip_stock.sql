-- 20260512000000_bons_skip_stock.sql
-- Allow entering "historical" bons (where articles were already physically
-- in stock before the system was set up) without bumping articles.stock.
-- The bon still tracks fournisseur dette + cheque follow-up, but the stock
-- column stays untouched.

BEGIN;

ALTER TABLE bons ADD COLUMN IF NOT EXISTS skip_stock BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN bons.skip_stock IS 'When TRUE, saving/editing this bon does NOT increment articles.stock. Used for historical bons where the merchandise was already physically counted before the system existed.';

COMMIT;
