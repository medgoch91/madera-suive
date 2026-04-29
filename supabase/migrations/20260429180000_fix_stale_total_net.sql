-- Repair bons whose total_net was left stale by the saveEditBon bug.
--
-- Root cause: saveEditBon (index.html:4402) recomputed b.total from the edited
-- lignes but never re-derived b.totalNet from total - remise. If you edited a
-- bon's lignes, total updated but total_net carried over the value from the
-- bon's original creation. Subsequent ledger / fournisseur-solde / P&L all
-- read total_net, so the displayed numbers were wrong (BON-0002 showed
-- total_net=346000 vs total=42250 — an 8x divergence that pushed ZAID BOIS's
-- solde way out of reality).
--
-- Conservative repair: only touch rows where total_net is impossibly larger
-- than total (it should never exceed total since remise can only subtract).
-- 1% tolerance for floating-point edge cases.

update bons
set total_net = round(total - (
  case
    when remise_type = '%' then total * coalesce(remise_val, 0) / 100
    else least(total, coalesce(remise_val, 0))
  end
)::numeric, 2)
where total_net > total * 1.001;
