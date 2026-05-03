-- ⚠️ DESTRUCTIVE — explicit per-action authorization 2026-05-03
-- User asked: "hyd les cheques li deja dkhlna bach ikon system vierge".
-- Wipe the cheques table so the test slate is fully clean.
--
-- Bons were already truncated in round 3 (no orphan cheque_id refs left).
-- Cheques don't have linked caisse_movements (caisse only mirrors avances
-- + tasweyas + tech payments), so no cash-box cleanup needed.

truncate table cheques restart identity cascade;
