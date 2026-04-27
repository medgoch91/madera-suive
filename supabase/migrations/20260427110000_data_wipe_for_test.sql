-- One-shot wipe of all business data for fresh-state testing.
-- Run after a verified backup (Telegram backup-maderadeco-2026-04-27.json).
-- Idempotent: TRUNCATE on already-empty tables is a no-op.
--
-- KEEPS:
--   auth.users           (Supabase Auth)
--   fact_societe         (company info: logo, ICE, address)
--   bot_subscribers      (Telegram chat IDs)
--   push_subscriptions   (web-push browsers)
--   audit_log            (full history kept)
--   schema, RLS policies, indexes, cron schedules — untouched

begin;

truncate table
  -- Financial
  bons, cheques,
  -- Catalog & pricing
  fournisseurs, articles, prix, supplier_products,
  -- Salaries & workers
  salaries, salarie_presences, salarie_avances, salarie_taswiyas, sal_catalogue,
  ouvriers_pc, ouvrier_pc_assign, ouvrier_pc_presences,
  -- Factures
  factures, fact_clients, fact_produits,
  -- Chantiers
  chantiers,
  -- Élec à distance / recipes / dispatches
  technicians, products, product_recipe,
  material_dispatches, subcontracting_orders, material_returns, technician_payments,
  -- Bot transient state
  bot_conversations
restart identity cascade;

commit;
