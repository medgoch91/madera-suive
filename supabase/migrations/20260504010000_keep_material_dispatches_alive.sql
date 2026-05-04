-- 20260504010000_keep_material_dispatches_alive.sql
-- Follow-up to 20260504000000.
-- The original migration renamed material_dispatches → material_dispatches_archive_2026_05.
-- This breaks the legacy #elec-dist page (which still reads/writes the original
-- name during the M8 transition). Revert the rename so both systems run in
-- parallel. The new BS hub uses bons_sortie / bons_sortie_lines; legacy elec-dist
-- continues against material_dispatches. Strip elec-dist properly in a later pass.

BEGIN;

ALTER TABLE material_dispatches_archive_2026_05 RENAME TO material_dispatches;

COMMIT;
