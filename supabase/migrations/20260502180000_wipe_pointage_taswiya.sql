-- ⚠️ DESTRUCTIVE — explicit per-action authorization 2026-05-02
-- User asked to wipe pointage + settlements + avances so they can start the
-- carry-forward flow with a clean slate. Workers, articles, suppliers,
-- bons, cheques, factures, and free caisse entries are preserved.
--
-- All affected tables are listed in the same TRUNCATE so internal FKs
-- (salarie_avances.settled_in_tasweya → salarie_taswiyas.id, etc.) don't
-- block the operation. CASCADE is kept as a belt-and-suspenders.

truncate table
  salarie_presences,
  ouvrier_pc_presences,
  salarie_taswiyas,
  pc_taswiyas,
  salarie_avances,
  pc_avances
  restart identity cascade;

-- caisse_movements has no real FK back to the avance/tasweya tables (just
-- a text linked_kind + bigint linked_id), so TRUNCATE doesn't touch the
-- mirror rows. Drop them explicitly so the cash-box ledger stays in sync.
-- Free / manual entries (linked_kind IS NULL) are intentionally preserved.
delete from caisse_movements
  where linked_kind in ('avance','pc_avance','sal_payment','pc_payment');
