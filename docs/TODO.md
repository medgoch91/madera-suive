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

## 🔴 À tester maintenant (critique)
- [ ] Run SQL dyal `material_returns` f Supabase (إرجاع سلعة ykhdem)
- [ ] Test Telegram `/newbon` → حفظ → verify f Supabase
- [ ] Test PWA install sur phone (Safari/Chrome → Add to Home Screen)
- [ ] Test Admin → "تصدير نسخة احتياطية" → verify JSON fih kolchi
- [ ] Test Admin → "استيراد نسخة احتياطية" → verify data restored
- [ ] Test mobile kaml:
  - [ ] #dashboard
  - [ ] #bons (list + new bon)
  - [ ] #cheques (list + new cheque)
  - [ ] #salaries (4 tabs: pointage, dashboard, historique, pcs)
  - [ ] #factures
  - [ ] #elec-dist (dispatch + returns)

## 🟡 Features essentielles à ajouter

### Security (important!)
- [ ] Supabase RLS: restrict `anon` write to authenticated only
- [ ] App-side: block destructive actions for non-admin
- [ ] Rate-limit Telegram bot per chat_id

### Telegram Bot
- [ ] `/balance` — total bons non-payés + cheques échéance proche
- [ ] `/bons` — list recent bons
- [ ] `/cheque` — ajout cheque sans app
- [ ] `/stock` — check stock article by name
- [ ] Notifications automatiques:
  - [ ] Cheque échéance dans 3 jours (déjà planifié @08:00 — verify)
  - [ ] Stock bas (< seuil)

### Dashboard & Reports
- [ ] Charts: dépenses par mois (chart.js CDN)
- [ ] Top 5 fournisseurs par volume
- [ ] Export PDF kaml (all bons du mois en un seul PDF)
- [ ] Rapport mensuel (email/telegram)

### Data
- [ ] Audit log table: user_id, action, table, row_id, old, new, at
- [ ] Soft delete (trash) avant hard delete
- [ ] Duplicate bon/cheque (clone as template)

## 🟢 Polish / Nice-to-have
- [ ] Dark/Light theme toggle
- [ ] Offline sync queue (save locally when offline, sync when online)
- [ ] Multi-language (FR/AR toggle)
- [ ] Share cheque image via Telegram directement
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
