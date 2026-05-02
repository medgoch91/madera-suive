-- Avances carry forward across settlements: an unpaid avance stays in the
-- worker's "credit" until the next salKhallas/pcKhallas absorbs it. Two
-- additive columns let us link each settled avance back to the tasweya that
-- absorbed it, so cancelling that tasweya can reopen the avances cleanly.
--
-- ADDITIVE migration (nullable columns + indexes only). No data destroyed.

alter table salarie_avances
  add column if not exists settled_in_tasweya bigint
    references salarie_taswiyas(id) on delete set null;

alter table pc_avances
  add column if not exists settled_in_tasweya bigint
    references pc_taswiyas(id) on delete set null;

-- Hot path: "what unpaid avances does this worker still owe?"
create index if not exists salarie_avances_pending_idx
  on salarie_avances(salarie_id) where rembourse = false;

create index if not exists pc_avances_pending_idx
  on pc_avances(ouvrier_id) where rembourse = false;
