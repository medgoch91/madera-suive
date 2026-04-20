-- ================================================================
--  سويفي — Supabase Database Schema
--  توليد تلقائي من index_26.html
-- ================================================================

-- ╔══════════════════════════════╗
-- ║  1. FOURNISSEURS             ║
-- ╚══════════════════════════════╝
create table if not exists fournisseurs (
  id          bigint generated always as identity primary key,
  nom         text        not null,
  tel         text        default '',
  ville       text        default '',
  email       text        default '',
  cat         text        default 'مورد',
  stat        text        default 'نشيط',
  notes       text        default '',
  created_at  timestamptz default now()
);

-- ╔══════════════════════════════╗
-- ║  2. ARTICLES                 ║
-- ╚══════════════════════════════╝
create table if not exists articles (
  id    bigint generated always as identity primary key,
  nom   text not null,
  unite text default '',
  cat   text default '',
  ref   text default ''
);

-- ╔══════════════════════════════╗
-- ║  3. PRIX                     ║
-- ╚══════════════════════════════╝
create table if not exists prix (
  id          bigint generated always as identity primary key,
  article_id  bigint references articles(id) on delete cascade,
  fournisseur text   not null,
  prix        numeric(12,2) default 0,
  unique (article_id, fournisseur)
);

-- ╔══════════════════════════════╗
-- ║  4. BONS                     ║
-- ╚══════════════════════════════╝
create table if not exists bons (
  id          bigint generated always as identity primary key,
  num         int           default 0,
  fournisseur text          not null,
  date        date,
  note        text          default '',
  statut      text          default 'Brouillon',
  remise_type text          default '%',
  remise_val  numeric(10,2) default 0,
  total       numeric(12,2) default 0,
  total_net   numeric(12,2) default 0,
  cheque_id   bigint        default null,
  lignes      jsonb         default '[]',
  created_at  timestamptz   default now()
);

-- ╔══════════════════════════════╗
-- ║  5. CHEQUES                  ║
-- ╚══════════════════════════════╝
create table if not exists cheques (
  id          bigint generated always as identity primary key,
  num         int           default 0,
  fournisseur text          not null,
  montant     numeric(12,2) default 0,
  date        date,
  echeance    date          default null,
  status      text          default 'معلق',
  bon_ids     jsonb         default '[]',
  created_at  timestamptz   default now()
);

-- ╔══════════════════════════════╗
-- ║  6. SALARIES                 ║
-- ╚══════════════════════════════╝
create table if not exists salaries (
  id           bigint generated always as identity primary key,
  nom          text          not null,
  prenom       text          default '',
  poste        text          default '',
  tel          text          default '',
  cin          text          default '',
  salaire_base numeric(10,2) default 0,
  taux_hsup    numeric(6,2)  default 0,
  actif        boolean       default true,
  notes        text          default '',
  created_at   timestamptz   default now()
);

-- ╔══════════════════════════════╗
-- ║  7. SALARIE_PRESENCES        ║
-- ╚══════════════════════════════╝
create table if not exists salarie_presences (
  id           bigint generated always as identity primary key,
  salarie_id   bigint references salaries(id) on delete cascade,
  date         date not null,
  statut       text          default 'present',   -- present / absent / conge / demi
  heures_supp  numeric(6,2)  default 0,
  taux_horaire numeric(8,2)  default 0,
  notes        text          default '',
  unique (salarie_id, date)
);

-- ╔══════════════════════════════╗
-- ║  8. SALARIE_AVANCES          ║
-- ╚══════════════════════════════╝
create table if not exists salarie_avances (
  id         bigint generated always as identity primary key,
  salarie_id bigint references salaries(id) on delete cascade,
  montant    numeric(10,2) default 0,
  date       date,
  notes      text          default '',
  rembourse  boolean       default false,
  created_at timestamptz   default now()
);

-- ╔══════════════════════════════╗
-- ║  9. SALARIE_TASWIYAS         ║
-- ╚══════════════════════════════╝
create table if not exists salarie_taswiyas (
  id             bigint generated always as identity primary key,
  salarie_id     bigint references salaries(id) on delete cascade,
  nom_salarie    text          default '',
  montant        numeric(10,2) default 0,
  date_from      date,
  date_to        date,
  date_paiement  date,
  created_at     timestamptz   default now()
);

-- ╔══════════════════════════════╗
-- ║  10. SAL_CATALOGUE           ║
-- ╚══════════════════════════════╝
create table if not exists sal_catalogue (
  id    bigint generated always as identity primary key,
  nom   text          not null,
  unite text          default 'قطعة',
  prix  numeric(10,2) default 0
);

-- ╔══════════════════════════════╗
-- ║  11. OUVRIERS_PC             ║
-- ╚══════════════════════════════╝
create table if not exists ouvriers_pc (
  id    bigint generated always as identity primary key,
  nom   text    not null,
  actif boolean default true
);

-- ╔══════════════════════════════╗
-- ║  12. OUVRIER_PC_ASSIGN       ║
-- ╚══════════════════════════════╝
create table if not exists ouvrier_pc_assign (
  id         bigint generated always as identity primary key,
  ouvrier_id bigint references ouvriers_pc(id) on delete cascade,
  pc_nom     text          not null,
  prix       numeric(10,2) default 0
);

-- ╔══════════════════════════════╗
-- ║  13. OUVRIER_PC_PRESENCES    ║
-- ╚══════════════════════════════╝
create table if not exists ouvrier_pc_presences (
  id         bigint generated always as identity primary key,
  ouvrier_id bigint references ouvriers_pc(id) on delete cascade,
  date       date   not null,
  pc_nom     text   not null,
  qte        numeric(10,2) default 0,
  prix       numeric(10,2) default 0,
  unique (ouvrier_id, date, pc_nom)
);

-- ╔══════════════════════════════╗
-- ║  14. FACT_CLIENTS            ║
-- ╚══════════════════════════════╝
create table if not exists fact_clients (
  id      bigint generated always as identity primary key,
  nom     text   not null,
  ville   text   default '',
  ice     text   default '',
  tel     text   default '',
  adresse text   default ''
);

-- ╔══════════════════════════════╗
-- ║  15. FACT_PRODUITS           ║
-- ╚══════════════════════════════╝
create table if not exists fact_produits (
  id    bigint generated always as identity primary key,
  nom   text          not null,
  ref   text          default '',
  prix  numeric(10,2) default 0,
  tva   numeric(5,2)  default 20,
  unite text          default 'Pce'
);

-- ╔══════════════════════════════╗
-- ║  16. FACT_SOCIETE            ║
-- ╚══════════════════════════════╝
create table if not exists fact_societe (
  id      bigint generated always as identity primary key,
  nom     text   default '',
  ice     text   default '',
  if_num  text   default '',
  rc      text   default '',
  patente text   default '',
  ville   text   default '',
  tel     text   default '',
  fax     text   default '',
  email   text   default '',
  web     text   default '',
  adresse text   default '',
  logo    text   default ''   -- base64 image
);

-- ╔══════════════════════════════╗
-- ║  17. FACTURES                ║
-- ╚══════════════════════════════╝
create table if not exists factures (
  id           bigint generated always as identity primary key,
  num          int           default 0,
  client_id    bigint        default null references fact_clients(id) on delete set null,
  client_nom   text          default '',
  client_ville text          default '',
  client_ice   text          default '',
  date         date,
  echeance     date          default null,
  lang         text          default 'ar',
  mode         text          default 'espèces',
  lignes       jsonb         default '[]',
  total_ht     numeric(12,2) default 0,
  total_tva    numeric(12,2) default 0,
  total_ttc    numeric(12,2) default 0,
  statut       text          default 'معلقة',
  notes        text          default '',
  created_at   timestamptz   default now()
);

-- ================================================================
--  RLS — Disable for anon key (single-user app)
--  or enable below and add policies as needed
-- ================================================================
alter table fournisseurs          enable row level security;
alter table articles              enable row level security;
alter table prix                  enable row level security;
alter table bons                  enable row level security;
alter table cheques               enable row level security;
alter table salaries              enable row level security;
alter table salarie_presences     enable row level security;
alter table salarie_avances       enable row level security;
alter table salarie_taswiyas      enable row level security;
alter table sal_catalogue         enable row level security;
alter table ouvriers_pc           enable row level security;
alter table ouvrier_pc_assign     enable row level security;
alter table ouvrier_pc_presences  enable row level security;
alter table fact_clients          enable row level security;
alter table fact_produits         enable row level security;
alter table fact_societe          enable row level security;
alter table factures              enable row level security;

-- Allow anon full access (since app handles auth locally)
do $$
declare t text;
begin
  foreach t in array array[
    'fournisseurs','articles','prix','bons','cheques',
    'salaries','salarie_presences','salarie_avances','salarie_taswiyas','sal_catalogue',
    'ouvriers_pc','ouvrier_pc_assign','ouvrier_pc_presences',
    'fact_clients','fact_produits','fact_societe','factures'
  ] loop
    execute format('create policy "anon_all_%s" on %I for all to anon using (true) with check (true)', t, t);
  end loop;
end $$;

-- ================================================================
--  STOCK & ÉLECTRICITÉ À DISTANCE (ajouts post-v1)
-- ================================================================

-- ── articles.stock column (integer count) ───────────────────────
alter table articles add column if not exists stock int default 0;

-- ╔══════════════════════════════╗
-- ║  18. SUPPLIER_PRODUCTS       ║
-- ╚══════════════════════════════╝
create table if not exists supplier_products (
  id                       bigint generated always as identity primary key,
  supplier_id              bigint references fournisseurs(id) on delete cascade,
  product_id               bigint references articles(id)     on delete cascade,
  last_purchase_price_ttc  numeric(12,2) default 0,
  updated_at               timestamptz   default now(),
  unique (supplier_id, product_id)
);

-- ╔══════════════════════════════╗
-- ║  19. TECHNICIANS             ║
-- ╚══════════════════════════════╝
create table if not exists technicians (
  id         bigint generated always as identity primary key,
  nom        text        not null unique,
  phone      text        default null,
  created_at timestamptz default now()
);

-- ╔══════════════════════════════╗
-- ║  20. PRODUCTS (produits finis) ║
-- ╚══════════════════════════════╝
create table if not exists products (
  id                         bigint generated always as identity primary key,
  nom                        text          not null,
  ref                        text          default '',
  labor_cost_per_piece_ttc   numeric(10,2) default 0,
  created_at                 timestamptz   default now()
);

-- ╔══════════════════════════════╗
-- ║  21. PRODUCT_RECIPE (BOM)    ║
-- ╚══════════════════════════════╝
create table if not exists product_recipe (
  id                bigint generated always as identity primary key,
  product_id        bigint references products(id) on delete cascade,
  raw_material_id   bigint references articles(id) on delete cascade,
  quantity_needed   numeric(10,3) default 0,
  unique (product_id, raw_material_id)
);

-- ╔══════════════════════════════╗
-- ║  22. MATERIAL_DISPATCHES     ║
-- ╚══════════════════════════════╝
-- Envoi de matière au technicien (N lignes partagent bon_number)
create table if not exists material_dispatches (
  id               bigint generated always as identity primary key,
  technician_name  text          not null,
  article_id       bigint        references articles(id) on delete set null,
  quantity         numeric(10,2) default 0,
  bon_number       text          default null,
  created_at       timestamptz   default now()
);
create index if not exists idx_material_dispatches_bon on material_dispatches(bon_number);
create index if not exists idx_material_dispatches_tech on material_dispatches(technician_name);

-- ╔══════════════════════════════╗
-- ║  23. SUBCONTRACTING_ORDERS   ║
-- ╚══════════════════════════════╝
-- Livraison produit fini par le technicien
create table if not exists subcontracting_orders (
  id                         bigint generated always as identity primary key,
  technician_name            text          not null,
  product_id                 bigint        references products(id) on delete set null,
  quantity_received          numeric(10,2) default 0,
  labor_cost_per_piece_ttc   numeric(10,2) default 0,
  created_at                 timestamptz   default now()
);
create index if not exists idx_subcontracting_tech on subcontracting_orders(technician_name);

-- ╔══════════════════════════════╗
-- ║  24. MATERIAL_RETURNS        ║
-- ╚══════════════════════════════╝
-- Retour de matière du technicien — reason: 'bon' (retour stock) | 'defaut' (sort définitif)
create table if not exists material_returns (
  id               bigint generated always as identity primary key,
  technician_name  text          not null,
  article_id       bigint        references articles(id) on delete set null,
  quantity         numeric(10,2) default 0,
  reason           text          default 'bon' check (reason in ('bon','defaut')),
  bon_number       text          default null,
  note             text          default '',
  created_at       timestamptz   default now()
);
create index if not exists idx_material_returns_bon on material_returns(bon_number);
create index if not exists idx_material_returns_tech on material_returns(technician_name);

-- ╔══════════════════════════════╗
-- ║  25. TECHNICIAN_PAYMENTS     ║
-- ╚══════════════════════════════╝
-- Paiements (avances / règlements) de la main d'œuvre aux techniciens
create table if not exists technician_payments (
  id               bigint generated always as identity primary key,
  technician_name  text          not null,
  amount           numeric(10,2) default 0,
  pay_date         date          default (now() at time zone 'Africa/Casablanca')::date,
  note             text          default '',
  created_at       timestamptz   default now()
);
create index if not exists idx_technician_payments_tech on technician_payments(technician_name);
create index if not exists idx_technician_payments_date on technician_payments(pay_date);

-- ================================================================
--  RPC functions — atomic stock ops
-- ================================================================
create or replace function decrement_stock(row_id bigint, amount numeric)
returns void language plpgsql as $$
begin
  update articles set stock = greatest(0, coalesce(stock,0) - amount::int) where id = row_id;
end; $$;

create or replace function increment_stock(row_id bigint, amount numeric)
returns void language plpgsql as $$
begin
  update articles set stock = coalesce(stock,0) + amount::int where id = row_id;
end; $$;

-- ================================================================
--  RLS + anon policies for new tables
-- ================================================================
alter table supplier_products      enable row level security;
alter table technicians            enable row level security;
alter table products               enable row level security;
alter table product_recipe         enable row level security;
alter table material_dispatches    enable row level security;
alter table subcontracting_orders  enable row level security;
alter table material_returns       enable row level security;
alter table technician_payments    enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'supplier_products','technicians','products','product_recipe',
    'material_dispatches','subcontracting_orders','material_returns',
    'technician_payments'
  ] loop
    execute format('drop policy if exists "anon_all_%s" on %I', t, t);
    execute format('create policy "anon_all_%s" on %I for all to anon using (true) with check (true)', t, t);
  end loop;
end $$;

-- ╔══════════════════════════════╗
-- ║  26. AUDIT_LOG               ║
-- ╚══════════════════════════════╝
-- Tracks every write operation (POST/PATCH/DELETE) for accountability
create table if not exists audit_log (
  id          bigint generated always as identity primary key,
  user_name   text        default 'anon',
  action      text        not null,          -- POST | PATCH | DELETE
  table_name  text        not null,
  row_id      bigint      default null,
  details     text        default '',
  created_at  timestamptz default now()
);
create index if not exists idx_audit_created  on audit_log(created_at desc);
create index if not exists idx_audit_user     on audit_log(user_name);
create index if not exists idx_audit_table    on audit_log(table_name);

alter table audit_log enable row level security;
drop policy if exists "anon_all_audit_log" on audit_log;
create policy "anon_all_audit_log" on audit_log
  for all to anon using (true) with check (true);

-- ╔══════════════════════════════╗
-- ║  27. SOFT DELETE             ║
-- ╚══════════════════════════════╝
-- Add deleted_at to core transaction tables. Rows with deleted_at IS NOT NULL
-- are treated as trashed. Client queries filter `deleted_at=is.null` by default.
alter table bons     add column if not exists deleted_at timestamptz;
alter table cheques  add column if not exists deleted_at timestamptz;
alter table factures add column if not exists deleted_at timestamptz;

create index if not exists idx_bons_deleted     on bons(deleted_at)     where deleted_at is null;
create index if not exists idx_cheques_deleted  on cheques(deleted_at)  where deleted_at is null;
create index if not exists idx_factures_deleted on factures(deleted_at) where deleted_at is null;

-- ╔══════════════════════════════════════════════╗
-- ║  28. PAYMENT TYPES (cheque / effet / espece) ║
-- ╚══════════════════════════════════════════════╝
-- Extend the cheques table to support three payment types and a paid_at stamp.
-- Values: 'cheque' (default), 'effet' (promissory note), 'espece' (cash)
alter table cheques add column if not exists type text default 'cheque';
alter table cheques add column if not exists paid_at date;

-- Backfill existing rows as 'cheque'
update cheques set type = 'cheque' where type is null;

-- Drop any old check constraint then re-add (fully idempotent)
alter table cheques drop constraint if exists cheques_type_check;
alter table cheques add constraint cheques_type_check
  check (type in ('cheque','effet','espece'));

create index if not exists idx_cheques_type on cheques(type);

-- ╔══════════════════════════════════════════════╗
-- ║  29. COMPANY SIGNATURE (fact_societe)       ║
-- ╚══════════════════════════════════════════════╝
-- Reusable "cachet + signature" stored with company info, shown on factures + cheques.
alter table fact_societe add column if not exists signature text default '';

-- reload schema cache after DDL
notify pgrst, 'reload schema';
