#!/usr/bin/env bash
# =========================================================
#  XyneX Panel - keep-alive / auto-start setup (safe to run any time)
#
#  After this runs the panel:
#    * is running under PM2 (no need to type `npm start`),
#    * keeps running after you close the terminal / SSH session,
#    * is restarted automatically if it crashes,
#    * starts again by itself after a server reboot (systemd, or cron @reboot).
# =========================================================
set -u
cd "$(dirname "$(readlink -f "$0")")" || exit 1
APP_DIR="$(pwd)"
NAME="xynex-panel"
log() { echo "[autostart] $*"; }

# ---- 1. find / install PM2 ----
PM2="$(command -v pm2 || true)"
[ -z "$PM2" ] && [ -x "$APP_DIR/node_modules/.bin/pm2" ] && PM2="$APP_DIR/node_modules/.bin/pm2"
if [ -z "$PM2" ]; then
  log "PM2 not found - installing..."
  npm install -g pm2 >/dev/null 2>&1 || sudo npm install -g pm2 >/dev/null 2>&1 || npm install pm2 >/dev/null 2>&1
  PM2="$(command -v pm2 || echo "$APP_DIR/node_modules/.bin/pm2")"
fi
[ -x "$PM2" ] || { log "Could not install PM2."; exit 1; }

# ---- 2. make sure there is something to run, then start it ----
if [ ! -f dist/server.cjs ]; then
  log "dist/server.cjs missing - building first..."
  npm run build || { log "Build failed."; exit 1; }
fi
[ -f ecosystem.config.cjs ] || { log "ecosystem.config.cjs missing."; exit 1; }

if "$PM2" describe "$NAME" 2>/dev/null | grep -q "online"; then
  log "Panel is already running."
else
  "$PM2" delete "$NAME" >/dev/null 2>&1 || true
  "$PM2" start ecosystem.config.cjs || { log "PM2 failed to start the panel."; exit 1; }
  log "Panel started."
fi
"$PM2" save >/dev/null 2>&1 || true

# ---- 3. start on boot ----
registered=0
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  USER_NAME="$(id -un)"
  if [ "$(id -u)" = 0 ]; then
    "$PM2" startup systemd -u root --hp "$HOME" >/dev/null 2>&1 && registered=1
  elif command -v sudo >/dev/null 2>&1 && { sudo -n true 2>/dev/null || [ -t 0 ]; }; then
    sudo env PATH="$PATH" "$PM2" startup systemd -u "$USER_NAME" --hp "$HOME" >/dev/null 2>&1 && registered=1
  fi
  if [ "$registered" = 1 ]; then
    "$PM2" save >/dev/null 2>&1 || true
    log "Auto-start on reboot enabled (systemd: pm2-$USER_NAME)."
  fi
fi

# ---- 4. watchdog: also revives the panel if it hangs (not only if it crashes) ----
chmod +x healthcheck.sh 2>/dev/null || true
if command -v crontab >/dev/null 2>&1; then
  CRON_BOOT="@reboot PATH=\"$PATH\" cd \"$APP_DIR\" && bash autostart.sh >> \"$APP_DIR/autostart.log\" 2>&1 # xynex-autostart"
  CRON_WATCH="* * * * * PATH=\"$PATH\" cd \"$APP_DIR\" && bash healthcheck.sh >> \"$APP_DIR/autostart.log\" 2>&1 # xynex-autostart"
  ( crontab -l 2>/dev/null | grep -v "# xynex-autostart"
    [ "$registered" = 0 ] && echo "$CRON_BOOT"
    echo "$CRON_WATCH" ) | crontab - && log "Watchdog enabled (checks every minute via cron)."
  registered=1
fi

if [ "$registered" = 0 ]; then
  # no systemd and no cron (some containers): run a small background watchdog instead
  if [ -f .watchdog.pid ] && kill -0 "$(cat .watchdog.pid 2>/dev/null)" 2>/dev/null; then
    log "Background watchdog already running."
  else
    nohup setsid bash healthcheck.sh --loop >> "$APP_DIR/autostart.log" 2>&1 &
    log "Background watchdog started (no systemd/cron found)."
  fi
  log "NOTE: without systemd/cron the panel can't restart itself after the whole machine reboots."
fi

# ---- 5. honest warning for hosts that stop by themselves ----
if [ -n "${CODESPACES:-}" ] || [ -n "${GITPOD_WORKSPACE_ID:-}" ] || [ -n "${REPL_ID:-}" ] || [ -n "${CODESANDBOX_SSE:-}" ]; then
  log "WARNING: this looks like a free cloud IDE (Codespaces/Gitpod/Replit...). The WHOLE machine is stopped"
  log "         after some idle time, which no script can prevent. For real 24/7 use a VPS."
fi

log "Done. Check with: pm2 status"
