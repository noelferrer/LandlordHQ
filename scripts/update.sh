#!/bin/bash
# ============================================================
#  LandlordHQ — VPS Update Script
#  Runs on the server. Called by deploy.sh from your local Mac.
# ============================================================

set -e

APP_DIR="/var/www/landlordhq"
LOG_DIR="/var/log/landlordhq"
GITHUB_REPO="https://github.com/noelferrer/LandlordHQ.git"
GREEN="\033[0;32m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
CYAN="\033[0;36m"
RESET="\033[0m"

log()  { echo -e "${CYAN}[$(date '+%H:%M:%S')]${RESET} $1"; }
ok()   { echo -e "${GREEN}✔  $1${RESET}"; }
warn() { echo -e "${YELLOW}⚠  $1${RESET}"; }
fail() { echo -e "${RED}✘  $1${RESET}"; exit 1; }

echo ""
echo -e "${CYAN}=================================================${RESET}"
echo -e "${CYAN}   LandlordHQ — Deploying Update${RESET}"
echo -e "${CYAN}   $(date '+%A, %B %d %Y  %H:%M:%S')${RESET}"
echo -e "${CYAN}=================================================${RESET}"
echo ""

# ── 1. Verify app directory ──────────────────────────────────
[ -d "$APP_DIR" ] || fail "App directory not found: $APP_DIR"
cd "$APP_DIR"
ok "Working directory: $APP_DIR"

# ── 2. Ensure log directory exists ──────────────────────────
mkdir -p "$LOG_DIR"
ok "Log directory: $LOG_DIR"

# ── 3. Check .env exists ────────────────────────────────────
[ -f ".env" ] && ok ".env present" || warn ".env NOT found — app may not start correctly!"

# ── 4. Ensure GitHub remote is configured ───────────────────
if ! git remote get-url origin &>/dev/null; then
  log "No remote found — adding GitHub origin..."
  git remote add origin "$GITHUB_REPO"
  ok "Remote added: $GITHUB_REPO"
else
  ok "Remote: $(git remote get-url origin)"
fi

# ── 5. Pull latest code ──────────────────────────────────────
log "Fetching latest code from GitHub..."
git fetch origin main

BEFORE=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$BEFORE" = "$REMOTE" ]; then
  warn "Already up to date (${BEFORE:0:7}) — forcing file sync anyway..."
fi

# Reset to remote main (updates all tracked files; .env and data/db.json
# are in .gitignore so they are never touched)
git reset --hard origin/main
git clean -fd --exclude='.env' --exclude='data/' > /dev/null

AFTER=$(git rev-parse HEAD)
if [ "$BEFORE" != "$AFTER" ]; then
  ok "Updated: ${BEFORE:0:7} → ${AFTER:0:7}"
  echo ""
  log "Changes applied:"
  git log --oneline "$BEFORE".."$AFTER" 2>/dev/null || git log --oneline -5
  echo ""
else
  ok "Files synced at ${AFTER:0:7}"
fi

# ── 6. Install / update dependencies ────────────────────────
log "Installing dependencies..."
npm install --omit=dev --silent
ok "Dependencies installed"

# ── 7. Reload PM2 processes ─────────────────────────────────
log "Reloading PM2 processes..."

PM2_LIST=$(pm2 list 2>/dev/null || echo "")

restart_or_start() {
  local NAME="$1"
  if echo "$PM2_LIST" | grep -q "$NAME"; then
    pm2 restart "$NAME" > /dev/null 2>&1
    ok "Restarted: $NAME"
  else
    warn "$NAME not in PM2 list — skipping (will be created on first pm2 start ecosystem.config.js)"
  fi
}

restart_or_start "landlordhq-dashboard"
restart_or_start "landlordhq-bot"

pm2 save --force > /dev/null
ok "PM2 state saved"

# ── 8. Health check ─────────────────────────────────────────
log "Health check..."
sleep 3
HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/health 2>/dev/null || echo "000")

if [ "$HTTP" = "200" ] || [ "$HTTP" = "401" ] || [ "$HTTP" = "302" ]; then
  ok "Server responding (HTTP $HTTP)"
else
  warn "Health check returned HTTP $HTTP"
  log "Recent server logs:"
  pm2 logs landlordhq-dashboard --lines 15 --nostream 2>/dev/null || true
fi

# ── 9. Done ─────────────────────────────────────────────────
echo ""
echo -e "${CYAN}=================================================${RESET}"
echo -e "${GREEN}   Deploy complete!${RESET}"
echo -e "${CYAN}=================================================${RESET}"
echo ""
pm2 status
echo ""
log "Logs: pm2 logs landlordhq-dashboard  |  pm2 logs landlordhq-bot"
echo ""
