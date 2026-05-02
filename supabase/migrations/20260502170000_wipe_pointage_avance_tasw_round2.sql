-- ⚠️ DESTRUCTIVE — explicit per-action authorization 2026-05-02 (round 2)
-- User asked for a clean slate to re-test the carry-forward + rollover flow:
-- wipe pointage + settlements + avances + linked caisse rows. Workers,
-- articles, suppliers, free caisse entries are preserved.

truncate table
  salarie_presences,
  ouvrier_pc_presences,
  salarie_taswiyas,
  pc_taswiyas,
  salarie_avances,
  pc_avances
  restart identity cascade;

delete from caisse_movements
  where linked_kind in ('avance','pc_avance','sal_payment','pc_payment');
