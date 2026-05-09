#!/usr/bin/env bash
# Register the bot's slash-command menu with Telegram (the menu shown when
# the user taps "/" in the chat). Idempotent — re-run after adding any new
# command in supabase/functions/telegram-bot/.
#
# Usage:  ./scripts/telegram-set-commands.sh
# Needs: TG_TOKEN env var, or it'll fall back to the literal token used by
# this app.

set -euo pipefail

TG_TOKEN="${TG_TOKEN:-8522104650:AAE39NioJGCBG2qsAZHq3rVD_XNqtbgeMH4}"

curl -sS -X POST "https://api.telegram.org/bot${TG_TOKEN}/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{
    "commands": [
      {"command":"today","description":"📊 خلاصة اليوم"},
      {"command":"balance","description":"⚖️ رصيد البونات و الشيكات"},
      {"command":"khlas","description":"💰 الباقي للخدامة (أو /khlas <اسم>)"},
      {"command":"caisse","description":"💵 حالة الصندوق"},
      {"command":"stock","description":"📦 مخزون سلعة (مثل: /stock LED)"},
      {"command":"listbons","description":"📋 آخر البونات"},
      {"command":"newbon","description":"➕ إضافة بون جديد"},
      {"command":"cheque","description":"💳 إضافة شيك جديد"},
      {"command":"subscribe","description":"🔔 تفعيل الإشعارات"},
      {"command":"unsubscribe","description":"🔕 إيقاف الإشعارات"},
      {"command":"testpush","description":"🩺 تجربة Web Push"},
      {"command":"cancel","description":"✖ إلغاء العملية الجارية"},
      {"command":"help","description":"❓ المساعدة"}
    ]
  }'
echo
echo "✓ Commands registered. Verify in Telegram by tapping / in @APPSUIVEBOT chat."
