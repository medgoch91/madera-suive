-- Widen salary numeric columns so user-entered weekly amounts round-trip
-- cleanly through daily storage. Before this migration, salaire_base was
-- numeric(10,2) which made 700 weekly drift to 700.02 on the next reload
-- (700 / 6 = 116.6666… stored as 116.67, displayed back as 116.67 * 6).
--
-- numeric(12,4) gives us 4 decimals — enough for 700/6 = 116.6667 to
-- round-trip via *6 = 700.0002 → toFixed(2) = "700.00".
--
-- ALTER TYPE numeric → wider numeric is lossless: Postgres re-encodes the
-- existing values with extra precision, no data is lost. ADDITIVE migration.

alter table salaries
  alter column salaire_base type numeric(12,4),
  alter column taux_hsup    type numeric(12,4);

alter table salary_rates
  alter column salaire_base type numeric(12,4),
  alter column taux_hsup    type numeric(12,4);
