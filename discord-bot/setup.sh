#!/usr/bin/env bash
# XyneX Discord bot - one-shot setup: installs deps, asks for the settings, starts it under PM2 (24/7).
set -u
cd "$(dirname "$(readlink -f "$0")")" || exit 1

command -v node >/dev/null 2>&1 || { echo "Node.js 18+ is required."; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] || { echo "Node.js 18+ is required (you have $(node -v))."; exit 1; }

echo "Installing bot dependencies..."
npm install --omit=dev --no-audit --no-fund || { echo "npm install failed"; exit 1; }

# The bot only needs to know where the panel is and its API key. The Discord token and all
# permissions are entered in the panel: Admin -> API Keys -> Discord Bot.
if [ -n "${PANEL_URL:-}" ] && [ -n "${PANEL_API_KEY:-}" ]; then
  # non-interactive: command copied from the panel
  { echo "PANEL_URL=$PANEL_URL"; echo "PANEL_API_KEY=$PANEL_API_KEY"; } > .env
  chmod 600 .env
  echo ".env written from the command."
elif [ ! -f .env ]; then
  echo
  echo "=== Connect the bot to your panel ==="
  echo "(Panel -> Admin -> API Keys -> Discord Bot -> 'Create bot API key' shows both values.)"
  read -r -p "Panel URL [http://127.0.0.1:6767]: " PURL; PURL="${PURL:-http://127.0.0.1:6767}"
  read -r -p "Panel API key (starts with xynex-): " PKEY
  { echo "PANEL_URL=$PURL"; echo "PANEL_API_KEY=$PKEY"; } > .env
  chmod 600 .env
  echo ".env written."
fi

PM2="$(command -v pm2 || true)"
if [ -z "$PM2" ]; then npm install -g pm2 >/dev/null 2>&1 || sudo npm install -g pm2 >/dev/null 2>&1; PM2="$(command -v pm2 || true)"; fi
if [ -n "$PM2" ]; then
  "$PM2" delete xynex-bot >/dev/null 2>&1 || true
  "$PM2" start index.js --name xynex-bot --time && "$PM2" save
  echo
  echo "Bot is running under PM2 (24/7, restarts on crash). Logs: pm2 logs xynex-bot"
  echo "Next: open the panel -> Admin -> API Keys -> Discord Bot, paste your bot token and save."
  echo "Reboot persistence is set up by ../autostart.sh (run it once if you haven't)."
else
  echo "PM2 not available - starting in foreground. Press Ctrl+C to stop."
  node index.js
fi
