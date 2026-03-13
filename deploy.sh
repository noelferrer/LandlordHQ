#!/bin/bash
# ============================================================
#  LandlordHQ — One-Command Deploy (run this on your Mac)
#  Usage:  ./deploy.sh
# ============================================================

VPS_USER="root"
VPS_HOST="landlordhq.genolworks.online"
VPS_SCRIPT="/var/www/landlordhq/scripts/update.sh"

GREEN="\033[0;32m"
CYAN="\033[0;36m"
RED="\033[0;31m"
RESET="\033[0m"

echo ""
echo -e "${CYAN}Connecting to ${VPS_USER}@${VPS_HOST}...${RESET}"
echo ""

ssh -t "${VPS_USER}@${VPS_HOST}" "bash ${VPS_SCRIPT}"

EXIT_CODE=$?
echo ""
if [ $EXIT_CODE -eq 0 ]; then
  echo -e "${GREEN}✔  Deploy finished successfully.${RESET}"
  echo -e "${CYAN}   Visit: https://landlordhq.genolworks.online/${RESET}"
else
  echo -e "${RED}✘  Deploy exited with code $EXIT_CODE — check the output above.${RESET}"
fi
echo ""
