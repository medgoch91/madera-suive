-- Caisse module: cash-box ledger that auto-mirrors avances + settlements.
--
-- Concept: every time real cash leaves the box (avance to a worker, weekly
-- settlement, free spend) or enters (boss hands cash) we record a row in
-- caisse_movements. Linked rows reference the source so we never count twice
-- and a delete on the source cascades through. Manual rows have linked_kind
-- IS NULL — those are the "free" entries the user types directly.
--
-- ADDITIVE migration: creates new tables + backfills existing rows. No
-- destructive ops. Production-safe.

-- ── 1. pc_avances (parallel to salarie_avances for piece-workers) ─────────
create table if not exists pc_avances (
  id           bigint generated always as identity primary key,
  ouvrier_id   bigint not null references ouvriers_pc(id) on delete cascade,
  date         date   not null,
  montant      numeric(12,2) not null check (montant >= 0),
  notes        text   default '',
  rembourse    boolean default false,
  created_at   timestamptz default now()
);
create index if not exists pc_avances_ouvrier_idx on pc_avances(ouvrier_id, date desc);

alter table pc_avances enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='pc_avances'
      and policyname='authenticated_all_pc_avances'
  ) then
    create policy "authenticated_all_pc_avances"
      on public.pc_avances for all to authenticated
      using (true) with check (true);
  end if;
end $$;

-- ── 2. caisse_movements ───────────────────────────────────────────────────
create table if not exists caisse_movements (
  id            bigint generated always as identity primary key,
  date          date   not null default current_date,
  type          text   not null check (type in ('in','out')),
  amount        numeric(12,2) not null check (amount >= 0),
  designation   text   not null default '',
  -- linked_kind is one of:
  --   'avance'      → salarie_avances.id
  --   'pc_avance'   → pc_avances.id
  --   'sal_payment' → salarie_taswiyas.id
  --   'pc_payment'  → pc_taswiyas.id
  --   NULL          → free / manual entry
  linked_kind   text,
  linked_id     bigint,
  notes         text   default '',
  created_at    timestamptz default now(),
  deleted_at    timestamptz
);

create index if not exists caisse_movements_date_idx
  on caisse_movements(date desc, id desc) where deleted_at is null;

-- Prevents creating two caisse rows for the same source (idempotent backfill,
-- safe re-run on duplicate save attempts).
create unique index if not exists caisse_movements_link_uniq
  on caisse_movements(linked_kind, linked_id)
  where linked_kind is not null and linked_id is not null and deleted_at is null;

alter table caisse_movements enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='caisse_movements'
      and policyname='authenticated_all_caisse_movements'
  ) then
    create policy "authenticated_all_caisse_movements"
      on public.caisse_movements for all to authenticated
      using (true) with check (true);
  end if;
end $$;

-- ── 3. Backfill from existing avances + settlements ──────────────────────
-- Idempotent thanks to caisse_movements_link_uniq partial unique index.

-- 3a. salarie_avances → caisse OUT
insert into caisse_movements (date, type, amount, designation, linked_kind, linked_id, notes)
select
  a.date, 'out', a.montant,
  'سلفة — ' || coalesce(s.nom,'') || coalesce(' '||s.prenom,''),
  'avance', a.id, coalesce(a.notes,'')
from salarie_avances a
left join salaries s on s.id = a.salarie_id
where not exists (
  select 1 from caisse_movements cm
  where cm.linked_kind='avance' and cm.linked_id=a.id and cm.deleted_at is null
);

-- 3b. salarie_taswiyas → caisse OUT (the net cash actually paid)
insert into caisse_movements (date, type, amount, designation, linked_kind, linked_id, notes)
select
  coalesce(t.date_paiement, t.created_at::date),
  'out', t.montant,
  'تسوية — ' || coalesce(t.nom_salarie,''),
  'sal_payment', t.id, ''
from salarie_taswiyas t
where not exists (
  select 1 from caisse_movements cm
  where cm.linked_kind='sal_payment' and cm.linked_id=t.id and cm.deleted_at is null
);

-- 3c. pc_taswiyas → caisse OUT
insert into caisse_movements (date, type, amount, designation, linked_kind, linked_id, notes)
select
  coalesce(t.date_paiement, t.created_at::date),
  'out', t.montant,
  'تسوية PC — ' || coalesce(o.nom,''),
  'pc_payment', t.id, ''
from pc_taswiyas t
left join ouvriers_pc o on o.id = t.ouvrier_id
where not exists (
  select 1 from caisse_movements cm
  where cm.linked_kind='pc_payment' and cm.linked_id=t.id and cm.deleted_at is null
);
