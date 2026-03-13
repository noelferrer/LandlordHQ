#!/bin/bash
# ============================================================
#  LandlordHQ — VPS Update Script
#  Runs on the server. Called by deploy.sh from your local Mac.
# ============================================================

set -e  # Exit immediately on any error

APP_DIR="/var/www/landlordhq"
LOG_DIR="/var/log/landlordhq"
GREEN="\033[0;32m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
CYAN="\033[0;36m"
RESET="\033[0m"

log()  { echo -e "${CYAN}[$(date '+%H:%M:%S')]${RESET} $1"; }
ok()   { echo -e "${GREEN}[$(date '+%H:%M:%S')] ✔  $1${RESET}"; }
warn() { echo -e "${YELLOW}[$(date '+%H:%M:%S')] ⚠  $1${RESET}"; }
fail() { echo -e "${RED}[$(date '+%H:%M:%S')] ✘  $1${RESET}"; exit 1; }

echo ""
echo -e "${CYAN}=================================================${RESET}"
echo -e "${CYAN}   LandlordHQ — Deploying Update${RESET}"
echo -e "${CYAN}   $(date '+%A, %B %d %Y  %H:%M:%S')${RESET}"
echo -e "${CYAN}=================================================${RESET}"
echo ""

# ── 1. Ensure app directory exists ──────────────────────────
[ -d "$APP_DIR" ] || fail "App directory not found: $APP_DIR"
cd "$APP_DIR"
ok "Working directory: $APP_DIR"

# ── 2. Ensure log directory exists ──────────────────────────
mkdir -p "$LOG_DIR"
ok "Log directory ready: $LOG_DIR"

# ── 3. Check .env exists (never overwritten by git) ─────────
[ -f "$APP_DIR/.env" ] || warn ".env file not found — app may not start correctly!"

# ── 4. Pull latest code ─────────────────────────────────────
log "Pulling latest code from GitHub..."
git fetch origin main
BEFORE=$(git rev-parse HEAD)
git pull origin main
AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  warn "No new commits. Already up to date."
else
  ok "Updated: ${BEFORE:0:7} → ${AFTER:0:7}"
  echo ""
  log "Changes pulled:"
  git log --oneline "$BEFORE".."$AFTER"
  echo ""
fi

# ── 5. Install / update dependencies ────────────────────────
log "Installing dependencies..."
npm install --omit=dev --silent
ok "Dependencies installed"

# ── 6. Reload via PM2 ───────────────────────────────────────
log "Reloading PM2 processes..."

if pm2 list | grep -q "landlordhq"; then
  pm2 reload ecosystem.config.js --update-env
  ok "PM2 processes reloaded"
else
  warn "No existing PM2 processes found — starting fresh..."
  pm2 start ecosystem.config.js
  ok "PM2 processes started"
fi

# ── 7. Save PM2 process list ────────────────────────────────
pm2 save --force > /dev/null
ok "PM2 state saved"

# ── 8. Health check ─────────────────────────────────────────
log "Running health check..."
sleep 3  # Give processes a moment to settle

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/health 2>/dev/null || echo "000")

if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "401" ]; then
  ok "Server is responding (HTTP $HTTP_STATUS)"
else
  warn "Server health check returned HTTP $HTTP_STATUS — check logs if unexpected"
fi

# ── 9. Final status ─────────────────────────────────────────
echo ""
echo -e "${CYAN}=================================================${RESET}"
echo -e "${GREEN}   Deploy complete!${RESET}"
echo -e "${CYAN}=================================================${RESET}"
echo ""
pm2 status
echo ""
log "Logs: pm2 logs landlordhq-server  |  pm2 logs landlordhq-bot"
echo ""
