# سويفي — نظرة شاملة على النظام

**Live**: https://medgoch91.github.io/madera-suive/
**Repo**: git@github.com:medgoch91/madera-suive.git (`main`)
**Last update**: 2026-04-21

---

## 1. البنية العامة

```
┌─────────────────────────────────────────────────────────┐
│  Frontend (PWA)        ←→   Supabase (DB + REST)       │
│  index.html                 PostgREST anon-key          │
│  sw.js (cache + push)       RLS policies (anon all)     │
│  logo.svg / manifest                                     │
└─────────────────────────────────────────────────────────┘
                    ↕
┌─────────────────────────────────────────────────────────┐
│  Telegram Bot (Python)                                  │
│  telegram_bot.py                                        │
│  python-telegram-bot[job-queue] + httpx + pywebpush     │
│  Daily jobs: cheques, electricity, workers, monthly     │
└─────────────────────────────────────────────────────────┘
```

**3 طبقات** كلهم مستقلين: إلا طاح Supabase → backup JSON | إلا طاح البوط → التطبيق كيخدم عادي | إلا طاح التطبيق → البوط كيصيفط الإشعارات عادي.

---

## 2. Frontend — `index.html` (~14,400 سطر)

### الصفحات الرئيسية (Hash-based routing)
| Hash | الصفحة |
|------|--------|
| `#dashboard` | لوحة التحكم (إحصائيات + cards) |
| `#bons` | البونات (استقبال البضاعة) |
| `#cheques` | الشيكات / الكمبيالات / النقد |
| `#echeancier` | تقويم استحقاق الشيكات والكمبيالات |
| `#factures` | الفواتير + الكليان + المنتجات |
| `#fourns` | الفورنيسورات + الحساب (relevé PDF) |
| `#articles` | السلع + الستوك |
| `#salaries` | الخدامة + التسويات |
| `#elec-dist` | الكهرباء (bons + retours + stock) |
| `#chantiers` | الورشات + ديپونس-پار-شانتيي |
| `#admin` | الإعدادات + Backup + Audit Log + Web Push |

### الميزات الكبار
- **Backup / Restore JSON** — نسخة احتياطية كاملة
- **PWA** — كيخدم offline (cache v12-push)
- **Web Push** — إشعارات المتصفح (غير من GitHub Pages + Supabase)
- **Signature pad** — cachet ديال الشركة على الفاتورة والشيك
- **QR codes** على البونات
- **FR/AR toggle** على الفاتورة
- **Multi-select + bulk delete** (factures, clients, produits)
- **Race-safe num** — retry loop لـ `bon_num` و`facture_num`
- **Mobile bottom-nav** — واجهة mobile-first
- **Audit log** — كل تعديل مسجل

### Service Worker — `sw.js`
- Cache name: `suivi-v12-push`
- Network-first للـ HTML، cache-first للـ static
- `push` + `notificationclick` handlers

---

## 3. Backend — Supabase

### الجداول الرئيسية (`supabase_schema.sql`)
| الجدول | الاستعمال |
|--------|-----------|
| `bons` | بونات الاستقبال |
| `bon_lignes` | تفاصيل البون |
| `cheques` | شيكات/كمبيالات/نقد (type, status, echeance, paid_at, chantier_id) |
| `reglements` | règlements (رباط بين الشيك والبون) |
| `factures` + `facture_lignes` | الفواتير |
| `clients` / `produits` | زبناء ومنتجات |
| `fournisseurs` | الفورنيسورات |
| `articles` + `stock_moves` | السلع + حركات الستوك |
| `salaries` + `taswiyas` | الخدامة + التسويات |
| `elec_bons` + `elec_retours` + `elec_stock` | الكهرباء |
| `chantiers` | الورشات |
| `push_subscriptions` | Web Push subscribers |
| `audit_log` | سجل العمليات |

### Security
- RLS مفعّل على كل جدول
- Policies: `anon_all_*` (كلشي مفتوح للـ anon key — مؤقتًا حتى شراء السيرفور)
- **TODO**: auth proper + RLS tightening

---

## 4. Telegram Bot — `telegram_bot.py`

### Commands
| Command | الوصف |
|---------|-------|
| `/start` | تسجيل المستخدم |
| `/subscribe` | الاشتراك فـ الإشعارات |
| `/unsubscribe` | إلغاء الاشتراك |
| `/today` | ملخص اليوم (شيكات + كهرباء + خدامة) |
| `/listbons` | آخر البونات |
| `/balance` | الرصيد |
| `/stock` | الستوك |
| `/newbon` | إضافة بون جديد (conversation) |
| `/cheque` | إضافة شيك (conversation) |
| `/testpush` | تجربة Web Push |
| `/cancel` | إلغاء conversation |

### Scheduled Jobs (Africa/Casablanca TZ)
| Job | الوقت | الوصف |
|-----|-------|-------|
| `cheques_due_morning` | 08:00 | شيكات حلّت اليوم + متأخرات |
| `cheques_today_16` | 16:00 | Ping بالشيكات اللي باقي ما تخلّصوش + inline buttons |
| `cheques_today_18` | 18:00 | نفس الـ ping (stateless — كيعاود يستفسر Supabase) |
| `electricity_eod` | 19:00 | ملخص الكهرباء |
| `workers_eod` | 20:00 | ملخص الخدامة |
| `monthly_report` | 09:00 (يوم 1 من الشهر) | تقرير شهري |

### Inline Buttons (same-day cheque ping)
- `CHQPAID:<id>` → PATCH status=مصروف + paid_at=today
- `CHQUNPAID:<id>` → ack فقط
- `CHQDEFER:<id>` → PATCH echeance=today+7d

### Web Push Integration
- `send_web_push(title, body, url, tag)` — fan-out لكل المشتركين
- VAPID keys فـ `.env`: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
- مدمج فـ كل الـ jobs اللي كتصيفط إشعارات Telegram (parallel notification)
- Auto-cleanup لـ dead endpoints (404/410)

---

## 5. آخر Releases (chronological)

| Commit | الإضافة |
|--------|---------|
| `d738285` | **Web Push notifications** — VAPID keys + pywebpush + admin UI |
| `35e579f` | Print cheque من تسوية (prefilled nom/montant/date) |
| `1f25076` | Same-day cheque/effet ping 16h + 18h مع inline buttons |
| `272cbaa` | Chantiers: cheque form selector + dashboard card |
| `79691d8` | Chantiers: tag bons/cheques بـ color-coded filtering |
| `43545bc` | Facture: "Cachet & Signature Émetteur" centered |
| `06f4e1e` | Signature auto-persist + merge with local |
| `3a4a284` | Company signature (cachet) على الفاتورة والشيك |
| `9aa46c7` | Signature pad + échéancier + mobile bottom-nav + effet print |
| `4aa20b0` | Relevé fournisseur PDF |
| `31544ea` | Race-safe bon/cheque num |
| `43ffd81` | QR codes + FR/AR toggle + search |
| `fd53a27` | Server-side max(num) + retry loop |

---

## 6. Deployment

### GitHub Pages (Frontend)
```bash
git add index.html sw.js supabase_schema.sql docs/
git commit -m "feat: ..."
git push origin main
# → auto-deploys to https://medgoch91.github.io/madera-suive/
```

### Telegram Bot (محليًا على Mac حاليًا)
```bash
cd /Users/amine/Downloads/suivi-app
python3 telegram_bot.py
```

### Requirements
```
python-telegram-bot[job-queue]==21.10
httpx==0.27.0
pytz==2024.1
python-dotenv==1.0.1
pywebpush==2.0.0
```

### `.env` (ماشي commit'd)
```
BOT_TOKEN=...
SB_URL=...
SB_KEY=...
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:...
```

---

## 7. Pending / Deferred

- [ ] **logo.svg optimization** — 464KB raster embed (deferred)
- [ ] **Auth + RLS tightening** — waiting on server purchase
- [ ] **Bot migration to VPS** — حاليًا كيدور على Mac محليًا

---

## 8. Activation checklist — Web Push

1. Supabase SQL: `push_subscriptions` table + policy ✅
2. `pip3 install pywebpush` ✅
3. `.env` → VAPID keys ✅
4. البوط كيدور ويبين: `🌐 Web Push: enabled` ✅
5. Admin → WEB PUSH → فعّل الإشعارات ✅
6. تجربة: `/testpush` فـ Telegram

---

*آخر تحديث: 2026-04-21*
