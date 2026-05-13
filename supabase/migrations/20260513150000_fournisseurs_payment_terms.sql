-- 20260513150000_fournisseurs_payment_terms.sql
-- Per-fournisseur standard payment terms in days (e.g. 30/60/90/120).
-- The app uses this to suggest the échéance date when creating a cheque
-- for that fournisseur — échéance = max(linked_bon.date) + N days. The
-- user can still override the suggestion before saving.

BEGIN;

ALTER TABLE fournisseurs
  ADD COLUMN IF NOT EXISTS payment_terms_days INT;

COMMENT ON COLUMN fournisseurs.payment_terms_days IS
  'Standard payment terms in days. NULL = no preference. The new-cheque page suggests échéance = bon.date + this; user can override.';

COMMIT;
