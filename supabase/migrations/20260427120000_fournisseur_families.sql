-- Tag every fournisseur with the article families they actually sell.
-- Empty array = no filter (article picker shows the full catalog).
-- Non-empty = picker shows only articles whose `cat` matches one of these.

alter table fournisseurs
  add column if not exists families text[] default '{}';
