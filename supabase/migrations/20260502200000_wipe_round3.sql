-- ⚠️ DESTRUCTIVE — explicit per-action authorization 2026-05-02 (round 3)
-- Clean slate for retesting: wipe pointage + tasweyas + avances + bons +
-- "à distance" subcontracting flow + reset articles.stock to 0 + drop the
-- linked caisse mirror rows. Workers, articles, suppliers, cheques,
-- factures, manual caisse entries, salary_rates all preserved.

truncate table
  salarie_presences,
  ouvrier_pc_presences,
  salarie_taswiyas,
  pc_taswiyas,
  salarie_avances,
  pc_avances,
  bons,
  material_dispatches,
  material_returns,
  subcontracting_orders,
  technician_payments
  restart identity cascade;

update articles set stock = 0 where stock is not null;

delete from caisse_movements
  where linked_kind in ('avance','pc_avance','sal_payment','pc_payment','tech_payment');
