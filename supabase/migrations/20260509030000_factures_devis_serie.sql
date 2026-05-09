-- 20260509030000_factures_devis_serie.sql
-- Devis and factures share the same factures table but should each have
-- their own numbering sequence. Add a `serie` column ('fact' | 'devis')
-- and rebuild the uniqueness index to be per-serie.

BEGIN;

-- 1. Add serie column. Default 'fact' so legacy rows behave unchanged.
ALTER TABLE factures ADD COLUMN IF NOT EXISTS serie TEXT NOT NULL DEFAULT 'fact';

-- 2. Backfill: any row whose statut = 'ديفي' becomes serie='devis'.
UPDATE factures SET serie = 'devis' WHERE statut = 'ديفي' AND serie <> 'devis';

-- 3. Drop the old uniqueness index (num + year) and replace with a
-- (serie, num, year) one so DEV-2026-0001 and FAC-2026-0001 can coexist.
DROP INDEX IF EXISTS uniq_factures_num_year;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_factures_serie_num_year
  ON public.factures (serie, num, EXTRACT(year FROM date))
  WHERE deleted_at IS NULL;

-- 4. Renumber existing devis rows so they start from 1 within each year
-- + serie. Without this they'd keep the num they grabbed from the fact
-- sequence, which is confusing.
WITH ranked AS (
  SELECT id, EXTRACT(year FROM date)::INT AS yr,
         ROW_NUMBER() OVER (PARTITION BY EXTRACT(year FROM date) ORDER BY date NULLS LAST, id) AS new_num
  FROM factures
  WHERE serie = 'devis' AND deleted_at IS NULL
)
UPDATE factures f SET num = r.new_num
FROM ranked r WHERE f.id = r.id;

COMMIT;
