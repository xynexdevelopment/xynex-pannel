#!/usr/bin/env bash
#
# XyneX Panel — update installer
#
# Usage:
#   bash install.sh             apply the update and build
#   bash install.sh --push      apply, build, then commit and push to Git
#   bash install.sh --no-build  apply without building
#
# Environment:
#   XYNEX_REPO  Git URL to clone when no project is found (default below)
#   XYNEX_DIR   Directory to clone into (default: ./xynex-pannel)
#
set -uo pipefail

if [ -t 1 ]; then
  C=$'\e[36m'; G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; D=$'\e[2m'; B=$'\e[1m'; N=$'\e[0m'
else
  C=; G=; R=; Y=; D=; B=; N=
fi
ok()   { echo "  ${G}✔${N} $*"; }
info() { echo "  ${C}›${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }
fail() { echo "  ${R}✖ $*${N}"; exit 1; }

PUSH=0; BUILD=1
for arg in "$@"; do
  case "$arg" in
    --push) PUSH=1 ;;
    --no-build) BUILD=0 ;;
    -h|--help) sed -n '3,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "Unknown option: $arg (see --help)" ;;
  esac
done

echo
echo "  ${C}╭──────────────────────────────────────────╮${N}"
echo "  ${C}│${N}  ${B}XYNEX${N} ${C}//${N} ${B}PANEL${N}    ${D}update installer${N}      ${C}│${N}"
echo "  ${C}╰──────────────────────────────────────────╯${N}"
echo

# 1. Locate the project root (or fetch it)
REPO_URL="${XYNEX_REPO:-https://github.com/xynexdevelopment/xynex-pannel.git}"
is_root() { [ -f "$1/package.json" ] && [ -d "$1/src" ]; }
ROOT=""
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
for dir in "$PWD" "$SELF" "$PWD/xynex-pannel" "$PWD/.." "$PWD/../.."; do
  if [ -n "$dir" ] && [ -d "$dir" ]; then
    dir="$(cd "$dir" && pwd)"
    if is_root "$dir"; then ROOT="$dir"; break; fi
  fi
done

command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || fail "Node.js and npm are required."

if [ -z "$ROOT" ]; then
  command -v git >/dev/null 2>&1 || fail "Git is required to download the panel."
  TARGET="${XYNEX_DIR:-$PWD/xynex-pannel}"
  if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
    fail "No panel found, and $TARGET already exists and is not empty. Set XYNEX_DIR to another path."
  fi
  info "Downloading XyneX Panel…"
  git clone --depth 1 -q "$REPO_URL" "$TARGET" 2>/dev/null || fail "Could not download $REPO_URL (check the URL and your access)."
  ROOT="$(cd "$TARGET" && pwd)"
  ok "Downloaded  ${D}$ROOT${N}"
  FRESH=1
else
  ok "Project located  ${D}$ROOT${N}"
  FRESH=0
fi
cd "$ROOT"

# Keep an existing checkout current, but never touch local changes.
if [ "$FRESH" = 0 ] && [ -d .git ] && git remote get-url origin >/dev/null 2>&1; then
  if [ -z "$(git status --porcelain 2>/dev/null)" ]; then
    git pull --ff-only -q 2>/dev/null && ok "Repository up to date" || warn "Could not fast-forward; continuing with the current checkout."
  else
    info "Local changes detected; skipping repository update."
  fi
fi
[ -f src/components/AdminUsers.tsx ] || warn "This checkout does not include the Users page update yet."

# 2. Ensure file ownership (elevates only when required)
if [ ! -w . ] || [ -n "$(find . \( -path ./node_modules -o -path ./.git \) -prune -o ! -user "$(id -un)" -print -quit 2>/dev/null)" ]; then
  if command -v sudo >/dev/null 2>&1; then
    sudo -n chown -R "$(id -u):$(id -g)" . 2>/dev/null || sudo chown -R "$(id -u):$(id -g)" . || fail "Could not correct file permissions."
    ok "File permissions corrected"
  else
    fail "Some files are not writable and sudo is unavailable."
  fi
else
  ok "File permissions verified"
fi

# 3. Retire the replaced component (moved to backup, never deleted)
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP=".xynex-backup/$STAMP"
OLD="src/components/IntegrationsManager.tsx"
if [ -f "$OLD" ]; then
  mkdir -p "$BACKUP/$(dirname "$OLD")" && mv "$OLD" "$BACKUP/$OLD"
  ok "Retired $OLD  ${D}(backup: $BACKUP)${N}"
else
  ok "Legacy component already retired"
fi
if ! grep -qxF ".xynex-backup/" .gitignore 2>/dev/null; then
  echo ".xynex-backup/" >> .gitignore
  ok "Added .xynex-backup/ to .gitignore"
fi
grep -rIl "IntegrationsManager" src 2>/dev/null | head -3 | while read -r f; do
  warn "Stale reference to IntegrationsManager in $f"
done

# 4. Dependencies and build
if [ ! -d node_modules ]; then
  info "Installing dependencies…"
  if [ -f package-lock.json ]; then CMD="ci"; else CMD="install"; fi
  npm "$CMD" --no-audit --no-fund >/dev/null 2>&1 || fail "Dependency installation failed. Run 'npm $CMD' to see the error."
  ok "Dependencies installed"
fi
if [ "$BUILD" = 1 ]; then
  info "Building…"
  mkdir -p .xynex-backup
  if npm run build >.xynex-backup/build.log 2>&1; then
    ok "Build completed"
  else
    echo; tail -n 25 .xynex-backup/build.log; echo
    fail "Build failed. Full log: .xynex-backup/build.log"
  fi
else
  warn "Build skipped. Run 'npm run build' before deploying."
fi

# 5. Optional: commit and push (only reached after a successful build)
if [ "$PUSH" = 1 ]; then
  if git add -A && git commit -qm "Update: Users page, admin navigation and command palette" && git push; then
    ok "Changes pushed to remote"
  else
    warn "Push did not complete. Check 'git status'."
  fi
fi

if [ "$(id -u)" = "0" ] && [ -n "${SUDO_USER:-}" ]; then chown -R "$SUDO_USER" . 2>/dev/null; fi
echo
echo "  ${G}Update complete.${N} ${D}Restart the panel, then open Admin → Users. Press Ctrl+K for the command palette.${N}"
echo
