-- 20260509020000_doc_photos_cheques_factures.sql
-- Extend the bon-photos pattern (migration 20260509000000) to cheques and
-- factures: snap photo of the paper original w-r9i, archive forever.
-- Reuses the existing bon-photos Storage bucket — paths are namespaced by
-- prefix (cheque-{id}-..., facture-{id}-...) so all docs share quota.

BEGIN;

ALTER TABLE cheques  ADD COLUMN IF NOT EXISTS photo_path TEXT NULL;
ALTER TABLE factures ADD COLUMN IF NOT EXISTS photo_path TEXT NULL;

COMMENT ON COLUMN cheques.photo_path  IS 'Path inside bon-photos Storage bucket (prefix cheque-{id}-...).';
COMMENT ON COLUMN factures.photo_path IS 'Path inside bon-photos Storage bucket (prefix facture-{id}-...).';

COMMIT;
