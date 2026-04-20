# TODO — سويفي

> Updated: 2026-04-20. Check off as you go.

## ✅ Done (reference)
- [x] Mobile scroll & navigation (sidebar overlay, hamburger)
- [x] Hash-based routing (per-section URLs)
- [x] Mobile DOM fix (orphaned pages inside `.content`)
- [x] Telegram bot `/newbon` BON-NNNN format
- [x] Article card price/name alignment (prix ysar, isem yamin)
- [x] PWA (installable + offline via service worker)
- [x] JSON backup export (Admin → BACKUP & RESTORE)
- [x] JSON backup import (replace-all with CONFIRM)
- [x] Dashboard charts (Chart.js: monthly spend + top 5 fournisseurs)
- [x] Telegram `/balance` + `/stock` commands
- [x] Audit log table + client-side logging wrapper
- [x] Theme toggle (already wired, light mode ready)
- [x] Cheque montant wrapped with `#` for anti-tampering
- [x] Admin UI for audit_log (renderAdmin → AUDIT LOG section)
- [x] Telegram `/cheque` ConversationHandler (fournisseur → montant → échéance)
- [x] Telegram rate-limit (15 cmd / 60s per chat_id)
- [x] Telegram monthly report (day-1 @ 09:00 auto)
- [x] Export PDF mensuel des bons (📄 PDF شهري button in Bons toolbar)
- [x] Dashboard charts now respect period filter (`src` instead of `bons`)

## 🔴 À tester maintenant (critique)
- [ ] Run SQL dyal `material_returns` f Supabase (إرجاع سلعة ykhdem)
- [ ] Run SQL dyal `audit_log` f Supabase (tracking écritures)
- [ ] Run SQL dyal `deleted_at` columns (section 27 of supabase_schema.sql — soft delete)
- [ ] Test Telegram commands: `/newbon`, `/balance`, `/stock LED`
- [ ] Test PWA install sur phone (Safari/Chrome → Add to Home Screen)
- [ ] Test Admin → "تصدير نسخة احتياطية" → verify JSON fih kolchi
- [ ] Test Admin → "استيراد نسخة احتياطية" → verify data restored
- [ ] Test Dashboard charts (Chart.js loaded, bars + doughnut rendering)
- [ ] Test mobile kaml:
  - [ ] #dashboard
  - [ ] #bons (list + new bon)
  - [ ] #cheques (list + new cheque)
  - [ ] #salaries (4 tabs: pointage, dashboard, historique, pcs)
  - [ ] #factures
  - [ ] #elec-dist (dispatch + returns)

## 🟡 Features essentielles à ajouter

### Security (important — deferred, needs careful rollout)
- [ ] **Supabase RLS**: switch from `anon-all` to `authenticated` role
      - Requires: Supabase Auth (email/password) login in app
      - Breaks: current anon key won't write after RLS tightening
      - Plan: keep SELECT open, restrict INSERT/UPDATE/DELETE to authenticated
      - SQL template:
        ```sql
        drop policy if exists "anon_all_bons" on bons;
        create policy "anon_read_bons" on bons for select to anon using (true);
        create policy "auth_write_bons" on bons for all to authenticated using (true) with check (true);
        ```
- [ ] **App-side guards**: admin-only modals already gated via `currentUser.role`;
      audit every destructive action (now logged via `audit_log`)
- [ ] **Rate-limit Telegram bot** per chat_id (5 req/min, use simple in-memory dict)
- [ ] **API key rotation**: rotate `SB_KEY` every 3 months

### Telegram Bot
- [x] `/balance` — total bons non-payés + cheques échéance proche
- [x] `/listbons` — list recent bons (already present)
- [x] `/stock` — check stock article by name
- [x] `/cheque` — ajout cheque sans app (conversation handler like /newbon)
- [x] Rate-limit per chat_id (15 cmd/60s)
- [x] Monthly report (day-1 @ 09:00)
- [x] Share cheque image via Telegram directement (html2canvas + sendPhoto — 📤 button in print-cheque)
- [ ] Notifications automatiques:
  - [ ] Cheque échéance dans 3 jours (déjà planifié @08:00 — verify)
  - [x] Stock bas (< seuil) — déjà dans electricity summary @19:00

### Dashboard & Reports
- [x] Charts: dépenses par mois (chart.js CDN) — bar chart 6 months
- [x] Top 5 fournisseurs par volume — doughnut chart
- [x] Export PDF kaml (all bons du mois en un seul PDF) — button 📄 PDF شهري
- [x] Rapport mensuel sur Telegram (day-1 @ 09:00)
- [x] Filter charts by date preset (uses `src` = filtered bons)

### Data
- [x] Audit log table (audit_log in Supabase — run SQL before use)
- [x] Admin UI to view audit_log entries (renderAdmin → AUDIT LOG)
- [x] Soft delete (trash) avant hard delete — bons/cheques/factures + Admin Trash UI (restore/purge)
- [ ] Duplicate bon/cheque (clone as template)

## 🟢 Polish / Nice-to-have
- [x] Dark/Light theme toggle (btn dyal 🌙/☀️ f topbar)
- [x] Offline sync queue (localStorage queue, PATCH/DELETE, auto-drain on online, topbar badge) ✅ tested
- [ ] Multi-language (FR/AR toggle)
- [ ] QR code pour chaque bon (scan → open bon dans app)
- [ ] Global search improvements (search inside bon lignes)
- [ ] Keyboard shortcuts help modal (Cmd+K déjà présent)

## 🐛 Bugs connus (à vérifier)
- [ ] Header sticky sometimes perdu après scroll fort sur iOS
- [ ] Modal bottom-sheet sur iPhone — safe-area inset bas?

## 📝 Notes
- App URL: https://medgoch91.github.io/madera-suive/
- Repo: github.com/medgoch91/madera-suive
- Supabase: tpjrzgubttpqtxieioxe.supabase.co
- Telegram bot PID: check via `pgrep -fl telegram_bot.py`
- Bot token stocké en env var (pas de .env committé)
