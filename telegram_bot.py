#!/usr/bin/env python3
"""سويفي Bot — إنشاء البونات عبر Telegram + Notifications يومية"""

import datetime
import json
import os
import re
from typing import Optional
import httpx
import pytz
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application, CommandHandler, CallbackQueryHandler,
    MessageHandler, ConversationHandler, filters, ContextTypes
)

# ── Config ───────────────────────────────────────────────────────
# Load from .env (never commit secrets to git)
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
except ImportError:
    pass  # python-dotenv is optional; env vars can be set directly

BOT_TOKEN = os.getenv("BOT_TOKEN") or ""
SB_URL    = os.getenv("SB_URL",  "https://tpjrzgubttpqtxieioxe.supabase.co")
SB_KEY    = os.getenv("SB_KEY",  "sb_publishable_3gAq_lEpojE5_hT4yg4WtQ_oFqaFFfX")

if not BOT_TOKEN:
    raise SystemExit(
        "❌ BOT_TOKEN ma mawjoudch.\n"
        "   Khoudi f .env: BOT_TOKEN=8522104650:xxxxx\n"
        "   Wla: export BOT_TOKEN='...' qbel ma t-bdi l-bot."
    )
SB_HDR    = {
    "apikey": SB_KEY,
    "Authorization": f"Bearer {SB_KEY}",
    "Content-Type": "application/json",
}

# ── Notifications config ─────────────────────────────────────────
TZ               = pytz.timezone("Africa/Casablanca")
CHAT_IDS_FILE    = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chat_ids.json")
CHEQUE_CHECK_H     = 8   # 08:00 — chèques qui arrivent aujourd'hui
ELEC_SUMMARY_H     = 19  # 19:00 — électricité à distance (bons/retours/stock faible)
WORKERS_SUMMARY_H  = 20  # 20:00 — ملخص الخدامة
LOW_STOCK_THRESHOLD = 5  # seuil d'alerte sur articles.stock

# ── Rate limiter (per chat_id) ───────────────────────────────────
import time as _time
from collections import defaultdict as _defaultdict
_rate_bucket = _defaultdict(list)
RATE_WINDOW  = 60   # secondes
RATE_MAX     = 15   # commandes max par fenêtre

async def _check_rate(update: Update) -> bool:
    """Return True si ok, False si limit dépassé (déjà répondu à l'utilisateur)."""
    cid = update.effective_chat.id if update.effective_chat else 0
    now = _time.time()
    _rate_bucket[cid] = [t for t in _rate_bucket[cid] if now - t < RATE_WINDOW]
    if len(_rate_bucket[cid]) >= RATE_MAX:
        try:
            if update.message:
                await update.message.reply_text(
                    f"⚠️ شوية! {RATE_MAX} عملية ف {RATE_WINDOW}ث — استنى لحظة."
                )
        except Exception:
            pass
        return False
    _rate_bucket[cid].append(now)
    return True


def load_chat_ids() -> list:
    if not os.path.exists(CHAT_IDS_FILE):
        return []
    try:
        with open(CHAT_IDS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def save_chat_ids(ids: list) -> None:
    with open(CHAT_IDS_FILE, "w", encoding="utf-8") as f:
        json.dump(sorted(set(ids)), f)

# ── States ───────────────────────────────────────────────────────
S_FOUR, S_ART, S_QTY, S_NEW_NOM, S_NEW_UNITE, S_NEW_PRIX = range(6)
S_CHQ_FOUR, S_CHQ_MONTANT, S_CHQ_ECHEANCE = range(10, 13)
PAGE_SIZE = 8
UNITES = ["قطعة", "كغ", "طن", "لتر", "م", "م²", "م³"]


# ── Supabase ─────────────────────────────────────────────────────
async def sb_get(table: str, params: Optional[dict] = None) -> list:
    async with httpx.AsyncClient() as c:
        r = await c.get(f"{SB_URL}/rest/v1/{table}", headers=SB_HDR, params=params)
        r.raise_for_status()
        return r.json()


def _fmt_err(e: Exception) -> str:
    """Compact error message, strip long URLs for Telegram readability."""
    s = str(e)
    # Keep first line (usually status + short reason)
    first = s.split("\n")[0]
    if len(first) > 140:
        first = first[:137] + "..."
    return first


async def sb_post(table: str, data: dict) -> list:
    hdrs = {**SB_HDR, "Prefer": "return=representation"}
    async with httpx.AsyncClient() as c:
        r = await c.post(f"{SB_URL}/rest/v1/{table}", headers=hdrs, json=data)
        r.raise_for_status()
        return r.json()


async def sb_upsert(table: str, data: dict) -> None:
    hdrs = {**SB_HDR, "Prefer": "resolution=merge-duplicates,return=minimal"}
    async with httpx.AsyncClient() as c:
        r = await c.post(f"{SB_URL}/rest/v1/{table}", headers=hdrs, json=data)
        r.raise_for_status()


# ── Keyboards ────────────────────────────────────────────────────
def kb_fournisseurs(noms: list, page: int = 0) -> InlineKeyboardMarkup:
    start = page * PAGE_SIZE
    chunk = noms[start:start + PAGE_SIZE]
    rows = [
        [InlineKeyboardButton(noms[start + i], callback_data=f"F:{start + i}")]
        for i, _ in enumerate(chunk)
    ]
    nav = []
    if page > 0:
        nav.append(InlineKeyboardButton("◀️", callback_data=f"FP:{page - 1}"))
    if start + PAGE_SIZE < len(noms):
        nav.append(InlineKeyboardButton("▶️", callback_data=f"FP:{page + 1}"))
    if nav:
        rows.append(nav)
    rows.append([InlineKeyboardButton("❌ إلغاء", callback_data="CANCEL")])
    return InlineKeyboardMarkup(rows)


def kb_articles(arts: list, lignes: list, page: int = 0) -> InlineKeyboardMarkup:
    start = page * PAGE_SIZE
    chunk = arts[start:start + PAGE_SIZE]
    rows = []
    for a in chunk:
        label = a["nom"] + (f" ({a['unite']})" if a.get("unite") else "")
        rows.append([InlineKeyboardButton(label, callback_data=f"A:{a['id']}")])
    nav = []
    if page > 0:
        nav.append(InlineKeyboardButton("◀️", callback_data=f"AP:{page - 1}"))
    if start + PAGE_SIZE < len(arts):
        nav.append(InlineKeyboardButton("▶️", callback_data=f"AP:{page + 1}"))
    if nav:
        rows.append(nav)
    # ➕ إضافة سلعة جديدة — always available
    rows.append([InlineKeyboardButton("➕ سلعة جديدة", callback_data="NEWART")])
    if lignes:
        total = sum(l["qte"] * l["pu"] for l in lignes)
        rows.append([InlineKeyboardButton(
            f"💾 حفظ البون ({len(lignes)} سلع — {total:.2f} د.م.)",
            callback_data="SAVE"
        )])
    rows.append([InlineKeyboardButton("❌ إلغاء", callback_data="CANCEL")])
    return InlineKeyboardMarkup(rows)


def kb_unites() -> InlineKeyboardMarkup:
    rows = []
    chunk = []
    for i, u in enumerate(UNITES):
        chunk.append(InlineKeyboardButton(u, callback_data=f"U:{i}"))
        if len(chunk) == 3:
            rows.append(chunk)
            chunk = []
    if chunk:
        rows.append(chunk)
    rows.append([InlineKeyboardButton("❌ إلغاء", callback_data="CANCEL")])
    return InlineKeyboardMarkup(rows)


# ── Helpers ──────────────────────────────────────────────────────
def fmt_lignes(lignes: list) -> str:
    if not lignes:
        return "_لا توجد سلع_"
    lines, total = [], 0.0
    for l in lignes:
        s = l["qte"] * l["pu"]
        total += s
        pu_txt = f" × {l['pu']:.2f} = {s:.2f} د.م." if l["pu"] else ""
        lines.append(f"• {l['nom']} × {l['qte']}{pu_txt}")
    lines.append(f"\n💰 *الإجمالي: {total:.2f} د.م.*")
    return "\n".join(lines)


# ── /start ───────────────────────────────────────────────────────
async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not await _check_rate(update): return
    await update.message.reply_text(
        "👋 *سويفي Bot*\n\n"
        "📋 /newbon — إنشاء بون جديد\n"
        "💳 /cheque — إنشاء شيك جديد\n"
        "📊 /listbons — آخر البونات\n"
        "💰 /balance — الوضعية المالية\n"
        "📦 /stock — بحث في المخزون\n"
        "🔔 /subscribe — فعل الإشعارات اليومية\n"
        "🔕 /unsubscribe — وقف الإشعارات\n"
        "📅 /today — خلاصة اليوم فوراً",
        parse_mode="Markdown"
    )


# ── /subscribe & /unsubscribe ────────────────────────────────────
async def cmd_subscribe(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not await _check_rate(update): return
    cid = update.effective_chat.id
    ids = load_chat_ids()
    if cid in ids:
        await update.message.reply_text("🔔 راك مفعل الإشعارات من قبل.")
        return
    ids.append(cid)
    save_chat_ids(ids)
    await update.message.reply_text(
        f"✅ *تفعلو الإشعارات!*\n\n"
        f"🕗 صباح {CHEQUE_CHECK_H:02d}:00 — الشيكات لي كتحل اليوم\n"
        f"⚡ مساء {ELEC_SUMMARY_H:02d}:00 — بونات électricité + مخزون منخفض\n"
        f"🌙 مساء {WORKERS_SUMMARY_H:02d}:00 — ملخص الخدامة",
        parse_mode="Markdown"
    )


async def cmd_unsubscribe(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not await _check_rate(update): return
    cid = update.effective_chat.id
    ids = load_chat_ids()
    if cid in ids:
        ids.remove(cid)
        save_chat_ids(ids)
        await update.message.reply_text("🔕 توقفو الإشعارات.")
    else:
        await update.message.reply_text("ℹ️ ماكنتيش مفعل الإشعارات.")


# ── /today — خلاصة فورية ─────────────────────────────────────────
async def cmd_today(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not await _check_rate(update): return
    today = datetime.date.today().isoformat()
    cheques_msg = await build_cheques_due_message(today)
    elec_msg = await build_electricity_summary_message(today)
    workers_msg = await build_workers_summary_message(today)
    await update.message.reply_text(cheques_msg, parse_mode="Markdown")
    # elec: pas de Markdown — bon_number etc. contiennent des underscores
    await update.message.reply_text(elec_msg)
    await update.message.reply_text(workers_msg, parse_mode="Markdown")


# ── Notification builders ────────────────────────────────────────
async def build_cheques_due_message(today: str) -> str:
    """Cheques dueing today + overdue unpaid."""
    try:
        # Due today
        due_today = await sb_get("cheques", {
            "select": "num,fournisseur,montant,echeance,status",
            "echeance": f"eq.{today}",
        })
        # Overdue (echeance < today) and not paid
        overdue = await sb_get("cheques", {
            "select": "num,fournisseur,montant,echeance,status",
            "echeance": f"lt.{today}",
            "status": "neq.مصروف",
        })
    except Exception as e:
        return f"⚠️ خطأ ف جلب الشيكات: {e}"

    # Filter unpaid only for today
    due_today = [c for c in due_today if (c.get("status") or "") not in ("مصروف", "Payé")]

    if not due_today and not overdue:
        return f"✅ *الشيكات — {today}*\n\nما كاين حتى شيك اليوم أو متأخر."

    lines = [f"💳 *الشيكات — {today}*\n"]
    if due_today:
        total = sum(float(c.get("montant") or 0) for c in due_today)
        lines.append(f"🔔 *اليوم كيحل ({len(due_today)}):*")
        for c in due_today:
            m = float(c.get("montant") or 0)
            lines.append(f"• CHK-{int(c.get('num') or 0):04d} — {c.get('fournisseur','?')} — *{m:.2f} د.م.*")
        lines.append(f"   _المجموع: {total:.2f} د.م._\n")
    if overdue:
        total_o = sum(float(c.get("montant") or 0) for c in overdue)
        lines.append(f"⚠️ *متأخر ({len(overdue)}):*")
        for c in overdue[:10]:
            m = float(c.get("montant") or 0)
            lines.append(f"• CHK-{int(c.get('num') or 0):04d} — {c.get('fournisseur','?')} — {m:.2f} د.م. ({c.get('echeance','?')})")
        if len(overdue) > 10:
            lines.append(f"   _... و {len(overdue)-10} شيكات أخرى_")
        lines.append(f"   _المجموع المتأخر: {total_o:.2f} د.م._")
    return "\n".join(lines)


async def build_workers_summary_message(today: str) -> str:
    """End-of-day summary of salariés + ouvriers PC."""
    try:
        # Salariés presences
        presences = await sb_get("salarie_presences", {
            "select": "salarie_id,statut,heures_supp,taux_horaire",
            "date": f"eq.{today}",
        })
        # Ouvriers PC presences
        pc_rows = await sb_get("ouvrier_pc_presences", {
            "select": "ouvrier_id,pc_nom,qte,prix",
            "date": f"eq.{today}",
        })
    except Exception as e:
        return f"⚠️ خطأ ف جلب الخدامة: {e}"

    if not presences and not pc_rows:
        return f"🌙 *خلاصة الخدامة — {today}*\n\nما كاين حتى نشاط اليوم."

    # Load names lookup (best effort)
    sal_names = {}
    pc_names  = {}
    try:
        sids = list({p["salarie_id"] for p in presences if p.get("salarie_id")})
        if sids:
            sal = await sb_get("salaries", {
                "select": "id,nom,prenom",
                "id": f"in.({','.join(map(str, sids))})",
            })
            sal_names = {s["id"]: (f"{s.get('prenom','')} {s.get('nom','')}").strip() for s in sal}
        oids = list({p["ouvrier_id"] for p in pc_rows if p.get("ouvrier_id")})
        if oids:
            ouv = await sb_get("ouvriers_pc", {
                "select": "id,nom",
                "id": f"in.({','.join(map(str, oids))})",
            })
            pc_names = {o["id"]: o.get("nom","?") for o in ouv}
    except Exception:
        pass

    lines = [f"🌙 *خلاصة الخدامة — {today}*\n"]

    # Salariés section
    if presences:
        by_status = {"present": 0, "absent": 0, "conge": 0, "demi": 0}
        total_hsup = 0.0
        total_cost_hsup = 0.0
        present_list = []
        for p in presences:
            st = p.get("statut") or "present"
            by_status[st] = by_status.get(st, 0) + 1
            hs = float(p.get("heures_supp") or 0)
            tx = float(p.get("taux_horaire") or 0)
            total_hsup += hs
            total_cost_hsup += hs * tx
            if st == "present":
                name = sal_names.get(p.get("salarie_id"), f"#{p.get('salarie_id')}")
                extra = f" (+{hs:.1f}h)" if hs > 0 else ""
                present_list.append(f"• {name}{extra}")
        lines.append(f"👷 *أجراء ({by_status.get('present',0)} حاضر / {by_status.get('absent',0)} غايب / {by_status.get('demi',0)} نصف / {by_status.get('conge',0)} عطلة):*")
        for p in present_list[:15]:
            lines.append(p)
        if len(present_list) > 15:
            lines.append(f"   _... و {len(present_list)-15} آخرون_")
        if total_hsup > 0:
            lines.append(f"   ⏱️ ساعات إضافية: *{total_hsup:.1f}h* = {total_cost_hsup:.2f} د.م.")
        lines.append("")

    # Ouvriers PC section (pieces)
    if pc_rows:
        per_ouvrier = {}
        grand_total_qte  = 0.0
        grand_total_cost = 0.0
        for r in pc_rows:
            oid  = r.get("ouvrier_id")
            qte  = float(r.get("qte") or 0)
            prix = float(r.get("prix") or 0)
            cost = qte * prix
            grand_total_qte  += qte
            grand_total_cost += cost
            if oid not in per_ouvrier:
                per_ouvrier[oid] = {"qte": 0.0, "cost": 0.0, "items": []}
            per_ouvrier[oid]["qte"]  += qte
            per_ouvrier[oid]["cost"] += cost
            per_ouvrier[oid]["items"].append(f"{r.get('pc_nom','?')} × {qte:.0f}")
        lines.append(f"🔧 *ouvriers PC ({len(per_ouvrier)}):*")
        for oid, d in list(per_ouvrier.items())[:15]:
            name = pc_names.get(oid, f"#{oid}")
            items = " · ".join(d["items"][:3])
            lines.append(f"• {name} — {d['qte']:.0f} قطعة = *{d['cost']:.2f} د.م.*")
            if items:
                lines.append(f"   _{items}_")
        lines.append(f"   📦 *المجموع: {grand_total_qte:.0f} قطعة = {grand_total_cost:.2f} د.م.*")
    return "\n".join(lines)


# ── Daily scheduled jobs ─────────────────────────────────────────
async def job_cheques_due(context: ContextTypes.DEFAULT_TYPE):
    ids = load_chat_ids()
    if not ids:
        return
    today = datetime.date.today().isoformat()
    msg = await build_cheques_due_message(today)
    for cid in ids:
        try:
            await context.bot.send_message(chat_id=cid, text=msg, parse_mode="Markdown")
        except Exception as e:
            print(f"[job_cheques_due] fail {cid}: {e}")


async def job_workers_summary(context: ContextTypes.DEFAULT_TYPE):
    ids = load_chat_ids()
    if not ids:
        return
    today = datetime.date.today().isoformat()
    msg = await build_workers_summary_message(today)
    for cid in ids:
        try:
            await context.bot.send_message(chat_id=cid, text=msg, parse_mode="Markdown")
        except Exception as e:
            print(f"[job_workers_summary] fail {cid}: {e}")


async def job_electricity_summary(context: ContextTypes.DEFAULT_TYPE):
    ids = load_chat_ids()
    if not ids:
        return
    today = datetime.date.today().isoformat()
    msg = await build_electricity_summary_message(today)
    for cid in ids:
        try:
            # No parse_mode — keeps underscores/asterisks literal (bon_number, etc.)
            await context.bot.send_message(chat_id=cid, text=msg)
        except Exception as e:
            print(f"[job_electricity_summary] fail {cid}: {e}")


async def build_electricity_summary_message(today: str) -> str:
    """Daily électricité à distance summary + low stock alerts."""
    start = f"{today}T00:00:00"
    end   = f"{today}T23:59:59"
    # PostgREST date range: use a single `and=(col.gte.X,col.lte.Y)` filter
    range_filter = f"(created_at.gte.{start},created_at.lte.{end})"
    dispatches, returns, orders, low_stock = [], [], [], []
    errs = []
    try:
        dispatches = await sb_get("material_dispatches", {
            "select": "bon_number,technician_name,article_id,quantity,created_at",
            "and": range_filter,
        })
    except Exception as e:
        errs.append(f"dispatches: {_fmt_err(e)}")
    try:
        returns = await sb_get("material_returns", {
            "select": "bon_number,technician_name,quantity,reason,created_at",
            "and": range_filter,
        })
    except Exception as e:
        errs.append(f"returns: {_fmt_err(e)}")
    try:
        orders = await sb_get("subcontracting_orders", {
            "select": "technician_name,product_id,quantity_received,labor_cost_per_piece_ttc,created_at",
            "and": range_filter,
        })
    except Exception as e:
        errs.append(f"orders: {_fmt_err(e)}")
    try:
        low_stock = await sb_get("articles", {
            "select": "nom,ref,stock,unite,cat",
            "stock": f"lte.{LOW_STOCK_THRESHOLD}",
            "order": "stock.asc",
            "limit": "50",
        })
    except Exception as e:
        errs.append(f"low_stock: {_fmt_err(e)}")
    if errs and not (dispatches or returns or orders or low_stock):
        # Total failure — likely tables don't exist yet
        return "⚠️ خطأ ف جلب بيانات الكهرباء:\n" + "\n".join("• " + x for x in errs)

    lines = [f"⚡ *électricité — {today}*\n"]
    nothing = not dispatches and not returns and not orders and not low_stock
    if nothing:
        return "\n".join(lines) + "✅ ما كاين حتى حركة اليوم — المخزون سليم."

    # Dispatches today (group by bon_number)
    if dispatches:
        bons = {}
        for d in dispatches:
            b = d.get("bon_number") or f"#{d.get('article_id')}"
            if b not in bons:
                bons[b] = {"tech": d.get("technician_name",""), "qty": 0.0, "n": 0}
            bons[b]["qty"] += float(d.get("quantity") or 0)
            bons[b]["n"]   += 1
        total_qty = sum(b["qty"] for b in bons.values())
        lines.append(f"📤 بونات سورتي ({len(bons)} بون · {total_qty:.0f} قطعة):")
        for bn, info in list(bons.items())[:10]:
            lines.append(f"• {bn} — {info['tech']} — {info['n']} سلعة · {info['qty']:.0f}")
        if len(bons) > 10:
            lines.append(f"   ... و {len(bons)-10} آخرين")
        lines.append("")

    # Returns
    if returns:
        ret_bon = [r for r in returns if (r.get("reason") or "bon") != "defaut"]
        ret_def = [r for r in returns if r.get("reason") == "defaut"]
        qty_bon = sum(float(r.get("quantity") or 0) for r in ret_bon)
        qty_def = sum(float(r.get("quantity") or 0) for r in ret_def)
        lines.append(f"🔄 إرجاعات ({len(returns)}):")
        if ret_bon:
            lines.append(f"   ✅ صالح: {len(ret_bon)} سطر · {qty_bon:.0f} قطعة (رجعات للمخزون)")
        if ret_def:
            lines.append(f"   ❌ خربان: {len(ret_def)} سطر · {qty_def:.0f} قطعة (خسارة)")
        lines.append("")

    # Deliveries (produits finis livrés par techniciens)
    if orders:
        total_prod = sum(float(o.get("quantity_received") or 0) for o in orders)
        total_labor = sum(float(o.get("quantity_received") or 0) * float(o.get("labor_cost_per_piece_ttc") or 0) for o in orders)
        per_tech = {}
        for o in orders:
            t = o.get("technician_name","?")
            per_tech[t] = per_tech.get(t, 0.0) + float(o.get("quantity_received") or 0) * float(o.get("labor_cost_per_piece_ttc") or 0)
        lines.append(f"🏗️ تسليمات ({len(orders)} · {total_prod:.0f} منتج):")
        for t, v in sorted(per_tech.items(), key=lambda x: -x[1])[:10]:
            lines.append(f"• {t}: {v:.2f} د.م.")
        lines.append(f"   💰 مجموع اليد: {total_labor:.2f} د.م.")
        lines.append("")

    # Low stock alert
    if low_stock:
        lines.append(f"⚠️ مخزون منخفض (≤ {LOW_STOCK_THRESHOLD}) — {len(low_stock)} سلعة:")
        for a in low_stock[:15]:
            stock = int(a.get("stock") or 0)
            emoji = "🔴" if stock == 0 else "🟡"
            ref = a.get("ref") or ""
            ref_txt = f" · {ref}" if ref else ""
            lines.append(f"{emoji} {a.get('nom','?')}{ref_txt} — {stock} {a.get('unite','')}")
        if len(low_stock) > 15:
            lines.append(f"   ... و {len(low_stock)-15} سلعة")
    return "\n".join(lines)


# ── /listbons ────────────────────────────────────────────────────
def _fmt_bon_num(v):
    s = str(v or "")
    if s.startswith("BON-"):
        return s
    if s.isdigit():
        return f"BON-{int(s):04d}"
    return s or "BON-?"


async def cmd_listbons(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not await _check_rate(update): return
    rows = await sb_get("bons", {
        "select": "num,fournisseur,date,total_net,statut",
        "order": "id.desc",
        "limit": "10"
    })
    if not rows:
        await update.message.reply_text("ما كاين حتى بون.")
        return
    lines = []
    for b in rows:
        e = "✅" if b["statut"] == "Validé" else "⏳"
        lines.append(f"{e} {_fmt_bon_num(b['num'])} | {b['fournisseur']} | {float(b['total_net']):.2f} د.م. | {b['date']}")
    await update.message.reply_text(
        "📋 *آخر البونات:*\n\n" + "\n".join(lines),
        parse_mode="Markdown"
    )


# ── /balance — résumé financier ──────────────────────────────────
async def cmd_balance(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not await _check_rate(update): return
    today = datetime.date.today()
    soon = (today + datetime.timedelta(days=7)).isoformat()
    today_s = today.isoformat()

    bons = await sb_get("bons", {"select": "num,fournisseur,date,total_net,statut,cheque_id"}) or []
    chqs = await sb_get("cheques", {"select": "num,fournisseur,montant,echeance,status"}) or []

    bons_libre = [b for b in bons if not b.get("cheque_id")]
    total_libre = sum(float(b.get("total_net") or 0) for b in bons_libre)

    chq_pending = [c for c in chqs if (c.get("status") or "معلق") == "معلق"]
    total_pending = sum(float(c.get("montant") or 0) for c in chq_pending)

    chq_soon = [c for c in chq_pending
                if c.get("echeance") and today_s <= c["echeance"] <= soon]

    lines = [
        "💰 *Balance — سويفي*",
        "",
        f"📦 *البونات بلا شيك:* {len(bons_libre)}",
        f"   💸 المجموع: {total_libre:,.2f} د.م.",
        "",
        f"💳 *الشيكات المعلقة:* {len(chq_pending)}",
        f"   💸 المجموع: {total_pending:,.2f} د.م.",
    ]
    if chq_soon:
        lines.append("")
        lines.append(f"⚠️ *شيكات تستحق خلال 7 أيام:* {len(chq_soon)}")
        for c in sorted(chq_soon, key=lambda x: x.get("echeance") or ""):
            lines.append(f"   • {c.get('num','?')} — {c.get('fournisseur','?')} — {float(c.get('montant') or 0):,.2f} د.م. — {c.get('echeance','?')}")
    lines.append("")
    lines.append(f"📅 {today_s}")

    await update.message.reply_text("\n".join(lines), parse_mode="Markdown")


# ── /stock — بحث ستوك سلعة ──────────────────────────────────────
async def cmd_stock(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not await _check_rate(update): return
    query = " ".join(ctx.args).strip() if ctx.args else ""
    if not query:
        await update.message.reply_text(
            "📦 *بحث في الستوك*\n\nاستعمل: `/stock اسم_السلعة`\nمثلا: `/stock LED`",
            parse_mode="Markdown"
        )
        return
    rows = await sb_get("articles", {
        "select": "id,nom,unite,stock",
        "nom": f"ilike.*{query}*",
        "order": "nom",
        "limit": "15"
    }) or []
    if not rows:
        await update.message.reply_text(f"ما لقيت حتى سلعة ب: *{query}*", parse_mode="Markdown")
        return
    lines = [f"📦 *نتائج البحث — {query}:*", ""]
    for a in rows:
        stk = a.get("stock")
        stk_s = f"{int(float(stk))}" if stk is not None else "—"
        emoji = "🔴" if (stk is None or float(stk or 0) == 0) else ("🟡" if float(stk) < 5 else "🟢")
        lines.append(f"{emoji} {a['nom']} — *{stk_s}* {a.get('unite','قطعة')}")
    await update.message.reply_text("\n".join(lines), parse_mode="Markdown")


# ── /cheque — إنشاء شيك جديد ────────────────────────────────────
async def cmd_cheque(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not await _check_rate(update): return ConversationHandler.END
    ctx.user_data.clear()
    rows = await sb_get("fournisseurs", {"select": "id,nom", "order": "nom"})
    if not rows:
        await update.message.reply_text("⚠️ ما كاين حتى فورنيسور.")
        return ConversationHandler.END
    noms = [r["nom"] for r in rows]
    ctx.user_data["chq_fournisseurs"] = rows
    await update.message.reply_text(
        "💳 *شيك جديد — اختار الفورنيسور:*",
        parse_mode="Markdown",
        reply_markup=kb_fournisseurs(noms, 0)
    )
    return S_CHQ_FOUR


async def cb_chq_four_page(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    await q.answer()
    page = int(q.data.split(":")[1])
    noms = [r["nom"] for r in ctx.user_data["chq_fournisseurs"]]
    await q.edit_message_reply_markup(reply_markup=kb_fournisseurs(noms, page))
    return S_CHQ_FOUR


async def cb_chq_four(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    await q.answer()
    idx = int(q.data.split(":")[1])
    four_obj = ctx.user_data["chq_fournisseurs"][idx]
    ctx.user_data["chq_fournisseur"] = four_obj["nom"]
    await q.edit_message_text(
        f"✅ *{four_obj['nom']}*\n\n💰 اكتب المبلغ (د.م.):",
        parse_mode="Markdown"
    )
    return S_CHQ_MONTANT


async def enter_chq_montant(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    text = update.message.text.strip().replace(",", ".").replace(" ", "")
    try:
        montant = float(text)
        if montant <= 0:
            raise ValueError
    except ValueError:
        await update.message.reply_text("⚠️ دخل مبلغ صحيح — مثلاً: 1500 أو 2500.50")
        return S_CHQ_MONTANT
    ctx.user_data["chq_montant"] = montant
    today = datetime.date.today().isoformat()
    await update.message.reply_text(
        f"💰 *{montant:,.2f} د.م.*\n\n📅 اكتب تاريخ الاستحقاق (YYYY-MM-DD):\n"
        f"_مثلاً: {today}_",
        parse_mode="Markdown"
    )
    return S_CHQ_ECHEANCE


async def enter_chq_echeance(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    text = update.message.text.strip()
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", text):
        await update.message.reply_text("⚠️ تنسيق غلط — استعمل YYYY-MM-DD (مثلاً 2026-05-15)")
        return S_CHQ_ECHEANCE
    try:
        datetime.date.fromisoformat(text)
    except ValueError:
        await update.message.reply_text("⚠️ تاريخ غير صالح — حاول مرة أخرى")
        return S_CHQ_ECHEANCE
    echeance = text
    four = ctx.user_data["chq_fournisseur"]
    montant = ctx.user_data["chq_montant"]

    # Auto-increment num (like bons)
    try:
        rows = await sb_get("cheques", {"select": "num"})
        max_n = 0
        for r in rows or []:
            s = str(r.get("num") or "")
            m = re.match(r"^CHK-(\d+)$", s)
            if m:
                max_n = max(max_n, int(m.group(1)))
            elif s.isdigit():
                max_n = max(max_n, int(s))
        num_str = f"CHK-{max_n+1:04d}"
    except Exception:
        num_str = f"CHK-{datetime.datetime.now().strftime('%H%M%S')}"

    today = datetime.date.today().isoformat()
    try:
        result = await sb_post("cheques", {
            "num": num_str,
            "fournisseur": four,
            "montant": round(montant, 2),
            "echeance": echeance,
            "date_emission": today,
            "status": "معلق",
        })
        cid = result[0]["id"] if result else "?"
        await update.message.reply_text(
            f"✅ *{num_str} محفوظ!*\n\n"
            f"🏢 {four}\n"
            f"💰 {montant:,.2f} د.م.\n"
            f"📅 استحقاق: {echeance}\n\n"
            f"_ID: {cid}_",
            parse_mode="Markdown"
        )
    except Exception as e:
        await update.message.reply_text(f"❌ خطأ ف حفظ الشيك: {_fmt_err(e)}")
    ctx.user_data.clear()
    return ConversationHandler.END


# ── Monthly report (scheduled day-1 of each month) ───────────────
async def build_monthly_report_message(first_of_month: datetime.date) -> str:
    """Monthly summary: previous month totals + top fournisseurs + cheques overview."""
    # Previous month range
    if first_of_month.month == 1:
        prev_month = 12
        prev_year = first_of_month.year - 1
    else:
        prev_month = first_of_month.month - 1
        prev_year = first_of_month.year
    start = f"{prev_year}-{prev_month:02d}-01"
    # First day of current month = end-exclusive
    end_exclusive = first_of_month.isoformat()
    label = f"{prev_year}-{prev_month:02d}"

    try:
        bons = await sb_get("bons", {
            "select": "fournisseur,total_net,date",
            "and": f"(date.gte.{start},date.lt.{end_exclusive})",
            "limit": "5000",
        }) or []
        chqs_paid = await sb_get("cheques", {
            "select": "fournisseur,montant,echeance",
            "and": f"(echeance.gte.{start},echeance.lt.{end_exclusive})",
            "status": "eq.مصروف",
            "limit": "5000",
        }) or []
    except Exception as e:
        return f"⚠️ خطأ ف التقرير الشهري: {_fmt_err(e)}"

    total_bons = sum(float(b.get("total_net") or 0) for b in bons)
    total_chqs = sum(float(c.get("montant") or 0) for c in chqs_paid)
    per_four = {}
    for b in bons:
        f = b.get("fournisseur", "?")
        per_four[f] = per_four.get(f, 0.0) + float(b.get("total_net") or 0)
    top5 = sorted(per_four.items(), key=lambda x: -x[1])[:5]

    lines = [
        f"📊 *التقرير الشهري — {label}*",
        "",
        f"📦 البونات: *{len(bons)}* — {total_bons:,.2f} د.م.",
        f"💳 شيكات مصروفة: *{len(chqs_paid)}* — {total_chqs:,.2f} د.م.",
    ]
    if top5:
        lines.append("")
        lines.append("🏆 *أكبر 5 فورنيسورات:*")
        for f, v in top5:
            lines.append(f"• {f} — {v:,.2f} د.م.")
    return "\n".join(lines)


async def job_monthly_report(context: ContextTypes.DEFAULT_TYPE):
    today = datetime.date.today()
    if today.day != 1:
        return  # Only fire on day-1
    ids = load_chat_ids()
    if not ids:
        return
    msg = await build_monthly_report_message(today)
    for cid in ids:
        try:
            await context.bot.send_message(chat_id=cid, text=msg, parse_mode="Markdown")
        except Exception as e:
            print(f"[job_monthly_report] fail {cid}: {e}")


# ── /newbon — اختيار الفورنيسور ──────────────────────────────────
async def cmd_newbon(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not await _check_rate(update): return
    ctx.user_data.clear()
    ctx.user_data["lignes"] = []
    ctx.user_data["art_page"] = 0

    rows = await sb_get("fournisseurs", {"select": "id,nom", "order": "nom"})
    if not rows:
        await update.message.reply_text("⚠️ ما كاين حتى فورنيسور.")
        return ConversationHandler.END

    noms = [r["nom"] for r in rows]
    ctx.user_data["fournisseurs"] = rows  # list of {id, nom}
    await update.message.reply_text(
        "🏢 *بون جديد — اختار الفورنيسور:*",
        parse_mode="Markdown",
        reply_markup=kb_fournisseurs(noms, 0)
    )
    return S_FOUR


# ── S_FOUR ───────────────────────────────────────────────────────
async def cb_four_page(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    await q.answer()
    page = int(q.data.split(":")[1])
    noms = [r["nom"] for r in ctx.user_data["fournisseurs"]]
    await q.edit_message_reply_markup(
        reply_markup=kb_fournisseurs(noms, page)
    )
    return S_FOUR


async def cb_four(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    await q.answer()
    idx      = int(q.data.split(":")[1])
    four_obj = ctx.user_data["fournisseurs"][idx]
    four_id  = four_obj["id"]
    four     = four_obj["nom"]
    ctx.user_data["fournisseur"]    = four
    ctx.user_data["fournisseur_id"] = four_id

    sp_rows = await sb_get("supplier_products", {
        "select": "product_id,last_purchase_price_ttc",
        "supplier_id": f"eq.{four_id}"
    })

    arts = []
    if sp_rows:
        product_ids  = [str(r["product_id"]) for r in sp_rows]
        sp_price_map = {str(r["product_id"]): float(r["last_purchase_price_ttc"]) for r in sp_rows}
        arts = await sb_get("articles", {
            "select": "id,nom,unite",
            "id": f"in.({','.join(product_ids)})",
            "order": "nom"
        })
        for a in arts:
            a["pu"] = sp_price_map.get(str(a["id"]), 0.0)
    ctx.user_data["articles"] = arts

    if arts:
        msg = f"✅ *{four}*\n\n📦 اختار السلعة:"
    else:
        msg = (f"⚠️ *{four}*\n\nما كاين حتى سلعة مرتبطة بهذا الفورنيسور.\n"
               "استعمل ➕ باش تزيد أول سلعة.")

    await q.edit_message_text(
        msg,
        parse_mode="Markdown",
        reply_markup=kb_articles(arts, ctx.user_data["lignes"], 0)
    )
    return S_ART


# ── S_ART ────────────────────────────────────────────────────────
async def cb_art_page(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    await q.answer()
    page = int(q.data.split(":")[1])
    ctx.user_data["art_page"] = page
    await q.edit_message_reply_markup(
        reply_markup=kb_articles(ctx.user_data["articles"], ctx.user_data["lignes"], page)
    )
    return S_ART


async def cb_art(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    await q.answer()
    art_id = q.data.split(":")[1]
    art = next((a for a in ctx.user_data["articles"] if str(a["id"]) == art_id), {})
    ctx.user_data["cur_id"]  = art_id
    ctx.user_data["cur_nom"] = art.get("nom", "?")
    ctx.user_data["cur_pu"]  = art.get("pu", 0.0)

    pu = ctx.user_data["cur_pu"]
    pu_txt = f"السعر: *{pu:.2f} د.م.*" if pu else "(بلا سعر مسجل)"
    await q.message.reply_text(
        f"📦 *{art.get('nom','?')}* — {pu_txt}\n\nاكتب الكمية:",
        parse_mode="Markdown"
    )
    return S_QTY


# ── S_QTY ────────────────────────────────────────────────────────
async def enter_qty(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    text = update.message.text.strip().replace(",", ".")
    try:
        qte = float(text)
        if qte <= 0:
            raise ValueError
    except ValueError:
        await update.message.reply_text("⚠️ دخل عدد صحيح — مثلاً: 5 أو 2.5")
        return S_QTY

    nom = ctx.user_data["cur_nom"]
    aid = ctx.user_data["cur_id"]
    pu  = ctx.user_data["cur_pu"]
    lignes = ctx.user_data["lignes"]

    existing = next((l for l in lignes if l["aid"] == aid), None)
    if existing:
        existing["qte"] = qte
    else:
        lignes.append({"aid": aid, "nom": nom, "qte": qte, "pu": pu})

    page = ctx.user_data.get("art_page", 0)
    await update.message.reply_text(
        f"✅ *{nom}* × {qte} — مزاد!\n\n{fmt_lignes(lignes)}\n\n📦 زيد سلعة أخرى أو احفظ:",
        parse_mode="Markdown",
        reply_markup=kb_articles(ctx.user_data["articles"], lignes, page)
    )
    return S_ART


# ── NEW ARTICLE (inline creation) ────────────────────────────────
async def cb_new_art(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    await q.answer()
    await q.message.reply_text(
        "✍️ *سلعة جديدة*\n\nاكتب اسم السلعة:",
        parse_mode="Markdown"
    )
    return S_NEW_NOM


async def enter_new_nom(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    nom = update.message.text.strip()
    if not nom:
        await update.message.reply_text("⚠️ الاسم فارغ — حاول مرة أخرى.")
        return S_NEW_NOM
    # Check duplicate against already-loaded articles (current supplier)
    if any(a["nom"] == nom for a in ctx.user_data.get("articles", [])):
        await update.message.reply_text("⚠️ هاد السلعة موجودة بالفعل — اختارها من القائمة.")
        return S_NEW_NOM
    ctx.user_data["new_nom"] = nom
    await update.message.reply_text(
        f"📦 *{nom}*\n\nاختار الوحدة:",
        parse_mode="Markdown",
        reply_markup=kb_unites()
    )
    return S_NEW_UNITE


async def cb_new_unite(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    await q.answer()
    idx = int(q.data.split(":")[1])
    unite = UNITES[idx] if 0 <= idx < len(UNITES) else "قطعة"
    ctx.user_data["new_unite"] = unite
    nom = ctx.user_data.get("new_nom", "?")
    await q.edit_message_text(
        f"📦 *{nom}* ({unite})\n\n💰 اكتب الثمن TTC:",
        parse_mode="Markdown"
    )
    return S_NEW_PRIX


async def enter_new_prix(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    text = update.message.text.strip().replace(",", ".")
    try:
        prix = float(text)
        if prix < 0:
            raise ValueError
    except ValueError:
        await update.message.reply_text("⚠️ دخل رقم صحيح — مثلاً: 150 أو 45.50")
        return S_NEW_PRIX

    nom     = ctx.user_data["new_nom"]
    unite   = ctx.user_data.get("new_unite", "قطعة")
    four    = ctx.user_data["fournisseur"]
    four_id = ctx.user_data["fournisseur_id"]

    # Create article in Supabase
    try:
        result = await sb_post("articles", {
            "nom": nom, "unite": unite, "cat": "أخرى", "ref": ""
        })
        art_id = result[0]["id"]
    except Exception as e:
        await update.message.reply_text(f"❌ خطأ ف حفظ السلعة: {e}")
        return ConversationHandler.END

    # Link to supplier + save price (best effort)
    if prix > 0:
        try:
            await sb_upsert("supplier_products", {
                "supplier_id": four_id,
                "product_id": art_id,
                "last_purchase_price_ttc": prix,
                "updated_at": datetime.datetime.utcnow().isoformat() + "Z"
            })
            await sb_upsert("prix", {
                "article_id": art_id, "fournisseur": four, "prix": prix
            })
        except Exception:
            pass

    # Add to local catalog + set as current selection
    new_art = {"id": art_id, "nom": nom, "unite": unite, "pu": prix}
    ctx.user_data.setdefault("articles", []).append(new_art)
    ctx.user_data["articles"].sort(key=lambda a: a["nom"])
    ctx.user_data["cur_id"]  = str(art_id)
    ctx.user_data["cur_nom"] = nom
    ctx.user_data["cur_pu"]  = prix

    pu_txt = f"السعر: *{prix:.2f} د.م.*" if prix > 0 else "(بلا سعر)"
    await update.message.reply_text(
        f"✅ *{nom}* تزادت ومرتبطة ب {four} — {pu_txt}\n\nاكتب الكمية:",
        parse_mode="Markdown"
    )
    return S_QTY


# ── SAVE ─────────────────────────────────────────────────────────
async def cb_save(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    await q.answer()
    lignes = ctx.user_data.get("lignes", [])
    if not lignes:
        await q.answer("⚠️ زيد سلعة واحدة على الأقل!", show_alert=True)
        return S_ART

    four  = ctx.user_data["fournisseur"]
    today = datetime.date.today().isoformat()
    total = sum(l["qte"] * l["pu"] for l in lignes)

    lignes_json = [
        {"designation": l["nom"], "qte": l["qte"], "pu": l["pu"],
         "total": round(l["qte"] * l["pu"], 2)}
        for l in lignes
    ]

    rows = await sb_get("bons", {"select": "num"})
    max_n = 0
    for r in rows or []:
        s = str(r.get("num") or "")
        m = re.match(r"^BON-(\d+)$", s)
        if m:
            max_n = max(max_n, int(m.group(1)))
        elif s.isdigit():
            max_n = max(max_n, int(s))
    next_n = max_n + 1
    num_str = f"BON-{next_n:04d}"

    result = await sb_post("bons", {
        "num": num_str,
        "fournisseur": four,
        "date": today,
        "statut": "Brouillon",
        "remise_type": "%",
        "remise_val": 0,
        "total": round(total, 2),
        "total_net": round(total, 2),
        "lignes": lignes_json,
        "note": ""
    })

    bon_id = result[0]["id"] if result else "?"
    await q.edit_message_text(
        f"✅ *{num_str} محفوظ!*\n\n"
        f"🏢 {four}\n"
        f"📅 {today}\n\n"
        f"{fmt_lignes(lignes)}\n\n"
        f"_ID: {bon_id}_",
        parse_mode="Markdown"
    )
    ctx.user_data.clear()
    return ConversationHandler.END


# ── CANCEL ───────────────────────────────────────────────────────
async def cb_cancel(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    await q.answer()
    await q.edit_message_text("❌ ملغى.")
    ctx.user_data.clear()
    return ConversationHandler.END


async def cmd_cancel(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("❌ ملغى.")
    ctx.user_data.clear()
    return ConversationHandler.END


# ── Main ─────────────────────────────────────────────────────────
def main():
    app = Application.builder().token(BOT_TOKEN).build()

    conv = ConversationHandler(
        entry_points=[CommandHandler("newbon", cmd_newbon)],
        states={
            S_FOUR: [
                CallbackQueryHandler(cb_four_page, pattern=r"^FP:"),
                CallbackQueryHandler(cb_four,      pattern=r"^F:\d+$"),
                CallbackQueryHandler(cb_cancel,    pattern=r"^CANCEL$"),
            ],
            S_ART: [
                CallbackQueryHandler(cb_art_page, pattern=r"^AP:"),
                CallbackQueryHandler(cb_art,      pattern=r"^A:\d+$"),
                CallbackQueryHandler(cb_new_art,  pattern=r"^NEWART$"),
                CallbackQueryHandler(cb_save,     pattern=r"^SAVE$"),
                CallbackQueryHandler(cb_cancel,   pattern=r"^CANCEL$"),
            ],
            S_QTY: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, enter_qty),
            ],
            S_NEW_NOM: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, enter_new_nom),
            ],
            S_NEW_UNITE: [
                CallbackQueryHandler(cb_new_unite, pattern=r"^U:\d+$"),
                CallbackQueryHandler(cb_cancel,    pattern=r"^CANCEL$"),
            ],
            S_NEW_PRIX: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, enter_new_prix),
            ],
        },
        fallbacks=[CommandHandler("cancel", cmd_cancel)],
        per_message=False,
    )

    chq_conv = ConversationHandler(
        entry_points=[CommandHandler("cheque", cmd_cheque)],
        states={
            S_CHQ_FOUR: [
                CallbackQueryHandler(cb_chq_four_page, pattern=r"^FP:"),
                CallbackQueryHandler(cb_chq_four,      pattern=r"^F:\d+$"),
                CallbackQueryHandler(cb_cancel,        pattern=r"^CANCEL$"),
            ],
            S_CHQ_MONTANT:  [MessageHandler(filters.TEXT & ~filters.COMMAND, enter_chq_montant)],
            S_CHQ_ECHEANCE: [MessageHandler(filters.TEXT & ~filters.COMMAND, enter_chq_echeance)],
        },
        fallbacks=[CommandHandler("cancel", cmd_cancel)],
        per_message=False,
    )

    app.add_handler(CommandHandler("start",       cmd_start))
    app.add_handler(CommandHandler("listbons",    cmd_listbons))
    app.add_handler(CommandHandler("subscribe",   cmd_subscribe))
    app.add_handler(CommandHandler("unsubscribe", cmd_unsubscribe))
    app.add_handler(CommandHandler("today",       cmd_today))
    app.add_handler(CommandHandler("balance",     cmd_balance))
    app.add_handler(CommandHandler("stock",       cmd_stock))
    app.add_handler(conv)
    app.add_handler(chq_conv)

    # Daily notifications (Africa/Casablanca timezone)
    jq = app.job_queue
    if jq is not None:
        jq.run_daily(
            job_cheques_due,
            time=datetime.time(hour=CHEQUE_CHECK_H, minute=0, tzinfo=TZ),
            name="cheques_due_morning",
        )
        jq.run_daily(
            job_electricity_summary,
            time=datetime.time(hour=ELEC_SUMMARY_H, minute=0, tzinfo=TZ),
            name="electricity_eod",
        )
        jq.run_daily(
            job_workers_summary,
            time=datetime.time(hour=WORKERS_SUMMARY_H, minute=0, tzinfo=TZ),
            name="workers_eod",
        )
        # Monthly report — runs daily @ 09:00 but gated to day-1 inside the job
        jq.run_daily(
            job_monthly_report,
            time=datetime.time(hour=9, minute=0, tzinfo=TZ),
            name="monthly_report",
        )
        print(f"🔔 Jobs: cheques {CHEQUE_CHECK_H:02d}:00 | elec {ELEC_SUMMARY_H:02d}:00 | workers {WORKERS_SUMMARY_H:02d}:00 | monthly 09:00 (TZ: Africa/Casablanca)")
    else:
        print("⚠️ JobQueue غير متاح — ثبت: pip install python-telegram-bot[job-queue]")

    print("🤖 سويفي Bot running...")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
