#!/usr/bin/env bash
# XyneX Panel - watchdog. Restarts the panel if it is down OR stuck (port closed / not answering).
#   bash healthcheck.sh          -> check once (used by cron every minute)
#   bash healthcheck.sh --loop   -> check every 30s forever (used where cron/systemd don't exist)
cd "$(dirname "$(readlink -f "$0")")" || exit 1
APP_DIR="$(pwd)"
PORT="$(grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '"' | tr -d "'" | tr -d '\r')"
PORT="${PORT:-6767}"

alive() {
  if command -v curl >/dev/null 2>&1; then
    local code; code="$(curl -s -o /dev/null -m 8 -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null)"
    [ -n "$code" ] && [ "$code" != "000" ]
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null
  fi
}

heal() {
  # don't fight an update that is in progress
  [ -f .update.lock ] && [ -z "$(find .update.lock -mmin +30 2>/dev/null)" ] && return
  echo "[$(date '+%F %T')] panel not answering on :$PORT - restarting"
  bash autostart.sh >/dev/null 2>&1
  PM2="$(command -v pm2 || echo "$APP_DIR/node_modules/.bin/pm2")"
  "$PM2" restart xynex-panel >/dev/null 2>&1 || true
}

if [ "${1:-}" = "--loop" ]; then
  echo $$ > .watchdog.pid
  while true; do
    sleep 30
    alive || { sleep 5; alive || heal; }
  done
else
  alive || { sleep 5; alive || heal; }
fi
