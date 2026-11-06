#!/usr/bin/env bash
# =========================================================
#  XyneX Panel - safe updater
#  Used by:  install.sh (menu "Update Panel")  and  Admin Panel -> Updates
#
#  Guarantees:
#   * .env and .data/ (users, servers, settings, secrets) are copied to a
#     backup folder OUTSIDE the panel folder before anything is touched.
#   * If the update ever removes/overwrites them, they are restored.
#   * Only the last 10 backups are kept.
#
#  Backup location: $XYNEX_BACKUP_DIR  (default: ~/xynex-backups)
# =========================================================
set -u

cd "$(dirname "$(readlink -f "$0")")" || exit 1
APP_DIR="$(pwd)"
BACKUP_ROOT="${XYNEX_BACKUP_DIR:-$HOME/xynex-backups}"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$BACKUP_ROOT/pre-update-$TS"
LOCK="$APP_DIR/.update.lock"

log()  { echo "[update] $*"; }
fail() { echo "[update] ERROR: $*" >&2; rm -f "$LOCK"; exit 1; }

# ---- single-instance lock (stale locks older than 30 min are ignored) ----
if [ -f "$LOCK" ] && [ -z "$(find "$LOCK" -mmin +30 2>/dev/null)" ]; then
  fail "Another update is already running ($LOCK). If it is stuck, delete that file."
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

[ -d .git ] || fail "This folder is not a git repository, so it can't be updated automatically."

# ---- 1. backup runtime data ----
mkdir -p "$BACKUP_DIR" || fail "Can't create backup folder $BACKUP_DIR"
chmod 700 "$BACKUP_ROOT" "$BACKUP_DIR" 2>/dev/null || true
[ -f .env ]  && cp -a .env  "$BACKUP_DIR/.env"
[ -d .data ] && cp -a .data "$BACKUP_DIR/.data"
[ -f ecosystem.config.cjs ] && cp -a ecosystem.config.cjs "$BACKUP_DIR/ecosystem.config.cjs"
log "Backup saved to $BACKUP_DIR"

# keep only the 10 newest backups
ls -1dt "$BACKUP_ROOT"/pre-update-* 2>/dev/null | tail -n +11 | xargs -r rm -rf --

# ---- 2. make sure runtime files are never tracked ----
for entry in ".env" ".data/" "node_modules/" "dist/" "*.log" ".update.lock"; do
  grep -qxF "$entry" .gitignore 2>/dev/null || echo "$entry" >> .gitignore
done
for f in .env .data; do
  if [ -e "$f" ] && git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    log "$f was tracked by git - untracking it (the files themselves are kept)."
    git rm -r --cached "$f" >/dev/null 2>&1 || true
  fi
done

# ---- 3. fetch + update code ----
log "Fetching updates..."
git fetch origin || fail "git fetch failed - check network/DNS."

BRANCH="$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')"
[ -z "$BRANCH" ] && BRANCH="main"

if ! git pull --ff-only origin "$BRANCH" >/tmp/xynex_pull_err.log 2>&1; then
  log "Could not fast-forward - reconciling with origin/$BRANCH."
  if ! git diff --quiet || ! git diff --cached --quiet; then
    git stash push -m "xynex-update auto-stash $TS" >/dev/null 2>&1 || true
  fi
  git reset --hard "origin/$BRANCH" || { cat /tmp/xynex_pull_err.log; fail "git reset failed."; }
fi

# ---- 4. restore anything the update removed or overwrote ----
restore_needed=0
if [ -d "$BACKUP_DIR/.data" ]; then
  if [ ! -d .data ]; then restore_needed=1; fi
  if git ls-files --error-unmatch .data >/dev/null 2>&1; then restore_needed=1; fi
fi
if [ "$restore_needed" = 1 ]; then
  log "Data folder was affected by the update - restoring from backup."
  mkdir -p .data
  cp -a "$BACKUP_DIR/.data/." .data/
  git rm -r --cached .data >/dev/null 2>&1 || true
fi
if [ -f "$BACKUP_DIR/.env" ] && { [ ! -f .env ] || git ls-files --error-unmatch .env >/dev/null 2>&1; }; then
  log ".env was affected by the update - restoring from backup."
  cp -a "$BACKUP_DIR/.env" .env
  git rm --cached .env >/dev/null 2>&1 || true
fi
# a missing ecosystem file would make PM2 start from the wrong folder
[ ! -f ecosystem.config.cjs ] && [ -f "$BACKUP_DIR/ecosystem.config.cjs" ] && cp -a "$BACKUP_DIR/ecosystem.config.cjs" ecosystem.config.cjs

# ---- 5. dependencies + build ----
log "Installing dependencies..."
npm i || fail "npm install failed. Your data is safe (backup: $BACKUP_DIR)."
log "Building panel..."
npm run build || fail "Build failed. Your data is safe (backup: $BACKUP_DIR)."

# final safety net: data must still be there
if [ -d "$BACKUP_DIR/.data" ] && [ ! -d .data ]; then
  mkdir -p .data && cp -a "$BACKUP_DIR/.data/." .data/
fi

# ---- 6. make sure it keeps running + restart (restart is last: when started from the panel it ends our own process) ----
log "Update complete."
rm -f "$LOCK"
if [ -f autostart.sh ]; then
  bash autostart.sh || true        # starts the panel if it wasn't running + enables start-on-boot
fi
log "Restarting panel..."
if command -v pm2 >/dev/null 2>&1 || npx pm2 -v >/dev/null 2>&1; then
  npx pm2 restart xynex-panel --update-env || npx pm2 restart all --update-env || true
fi
log "Done. Data backup: $BACKUP_DIR"
