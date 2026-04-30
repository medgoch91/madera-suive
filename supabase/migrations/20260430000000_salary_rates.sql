-- Effective-dated salary rates so changing a worker's pay never silently
-- back-dates onto already-worked days.
--
-- The `salaries` table keeps its `salaire_base` / `taux_hsup` columns as a
-- denormalised "current rate" cache so existing reads continue to work. Pay
-- calculations switch to looking up `salary_rates` for the effective rate at
-- each date.
--
-- ADDITIVE migration: no drop / truncate / mass-update on existing data.

create table if not exists salary_rates (
  id              bigint generated always as identity primary key,
  salarie_id      bigint not null references salaries(id) on delete cascade,
  effective_from  date   not null,
  salaire_base    numeric(10,2) default 0,
  taux_hsup       numeric(6,2)  default 0,
  note            text default '',
  created_at      timestamptz default now()
);

-- Hot path: "what was this worker's rate on date D?"
create index if not exists salary_rates_lookup_idx
  on salary_rates(salarie_id, effective_from desc);

-- Seed each existing worker's current rate as effective from a far-past
-- date so all historical computations resolve to the rate that was in
-- the salaries master at the time of this migration. Idempotent: skips
-- workers who already have a salary_rates row.
insert into salary_rates (salarie_id, effective_from, salaire_base, taux_hsup, note)
select s.id, '1900-01-01'::date,
       coalesce(s.salaire_base, 0), coalesce(s.taux_hsup, 0),
       'seeded from salaries master at migration time'
from salaries s
where not exists (
  select 1 from salary_rates sr where sr.salarie_id = s.id
);

-- RLS: same shape as the rest of the data tables — authenticated only.
alter table salary_rates enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'salary_rates'
      and policyname = 'authenticated_all_salary_rates'
  ) then
    create policy "authenticated_all_salary_rates"
      on public.salary_rates
      for all to authenticated
      using (true) with check (true);
  end if;
end $$;
