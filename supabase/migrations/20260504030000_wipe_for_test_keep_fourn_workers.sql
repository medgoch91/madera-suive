-- 20260504030000_wipe_for_test_keep_fourn_workers.sql
-- Authorized clean-slate wipe before starting end-to-end testing of the
-- new bons-sortie hub (departments + tagging + BS RPCs + low-stock alerts).
--
-- User authorization: 2026-05-04 — "msa7 lia data ou sl3a li kyna bach
-- nbdaw test mais jamais tms7 fournisseur ola khdama".
--
-- KEPT (intentionally untouched):
--   fournisseurs, salaries, ouvriers_pc, technicians, departments,
--   chantiers, bot_subscribers, push_subscriptions, products,
--   product_recipe, sal_catalogue, fact_societe.
--
-- WIPED:
--   All transactional / activity tables — articles + everything that
--   references them (prices, bons, cheques, factures, BS, dispatches,
--   etc.) PLUS worker activity (presences, avances, taswiyas, payments,
--   salary_rates) and the caisse ledger + audit trail.

BEGIN;

-- Tier 1: dependents of articles + financial activity
TRUNCATE TABLE
  article_departments,
  bons_sortie_lines,
  bons_sortie,
  material_dispatches,
  material_returns,
  subcontracting_orders,
  supplier_products,
  prix,
  bons,
  cheques,
  factures,
  fact_clients,
  fact_produits
RESTART IDENTITY CASCADE;

-- Tier 2: worker activity
TRUNCATE TABLE
  salarie_presences,
  salarie_avances,
  salarie_taswiyas,
  ouvrier_pc_presences,
  ouvrier_pc_assign,
  pc_avances,
  pc_taswiyas,
  technician_payments,
  salary_rates
RESTART IDENTITY CASCADE;

-- Tier 3: ledgers + history
TRUNCATE TABLE
  caisse_movements,
  audit_log,
  bot_conversations
RESTART IDENTITY CASCADE;

-- Tier 4: articles (last because so many tables FK to it)
TRUNCATE TABLE articles RESTART IDENTITY CASCADE;

COMMIT;

-- Sanity check (informational; not enforced):
-- SELECT 'fournisseurs' AS t, COUNT(*) FROM fournisseurs
-- UNION ALL SELECT 'salaries',     COUNT(*) FROM salaries
-- UNION ALL SELECT 'ouvriers_pc',  COUNT(*) FROM ouvriers_pc
-- UNION ALL SELECT 'technicians',  COUNT(*) FROM technicians
-- UNION ALL SELECT 'departments',  COUNT(*) FROM departments;
