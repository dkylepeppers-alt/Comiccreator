#!/data/data/com.termux/files/usr/bin/bash
# ============================================
# AI Comic Creator - Termux Install Script
# ============================================
# Run this once to set up everything from
# a fresh Termux environment.
#
# One-liner install:
#   curl -fsSL https://raw.githubusercontent.com/dkylepeppers-alt/Comiccreator/master/install.sh | bash
#
# Or download and run manually:
#   curl -O https://raw.githubusercontent.com/dkylepeppers-alt/Comiccreator/master/install.sh
#   chmod +x install.sh
#   ./install.sh
# ============================================

set -e

REPO_URL="https://github.com/dkylepeppers-alt/Comiccreator.git"
INSTALL_DIR="${INSTALL_DIR:-$HOME/Comiccreator}"

# ANSI colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${BOLD}=================================="
echo -e "  AI Comic Creator - Installer"
echo -e "==================================${NC}"
echo ""

# Verify we are running inside Termux
if [ ! -d "/data/data/com.termux" ]; then
  echo -e "${YELLOW}[!] This script is designed for Termux on Android.${NC}"
  echo "    On other systems, install git and python3 manually, then:"
  echo "      git clone $REPO_URL"
  echo "      cd Comiccreator && python3 -m http.server 8080"
  exit 1
fi

# ---------- Dependencies ----------
echo -e "${CYAN}[*] Checking dependencies...${NC}"

install_pkg() {
  local pkg="$1"
  local cmd="${2:-$1}"
  if ! command -v "$cmd" &>/dev/null; then
    echo -e "${YELLOW}[*] Installing $pkg...${NC}"
    pkg install -y "$pkg" || { echo -e "${RED}[!] Failed to install $pkg. Check your internet connection and try again.${NC}"; exit 1; }
  else
    echo -e "${GREEN}[+] $pkg already installed${NC}"
  fi
}

# Update package lists quietly
pkg update -y -q 2>/dev/null || true

install_pkg git
install_pkg python python3  # Termux package 'python' provides the python3 binary

# ---------- Clone ----------
if [ -d "$INSTALL_DIR/.git" ]; then
  echo ""
  echo -e "${CYAN}[*] Repository already exists at ${INSTALL_DIR}${NC}"
  echo -e "${CYAN}[*] Running update instead...${NC}"
  exec "$INSTALL_DIR/update.sh"
fi

echo ""
echo -e "${CYAN}[*] Cloning repository to ${INSTALL_DIR}...${NC}"
git clone "$REPO_URL" "$INSTALL_DIR" || { echo -e "${RED}[!] Failed to clone repository. Check your internet connection and try again.${NC}"; exit 1; }

# ---------- Make scripts executable ----------
chmod +x "$INSTALL_DIR/server.sh"
chmod +x "$INSTALL_DIR/update.sh"
chmod +x "$INSTALL_DIR/install.sh"
chmod +x "$INSTALL_DIR/scripts/bump-version.sh"
chmod +x "$INSTALL_DIR/scripts/install-hooks.sh"
chmod +x "$INSTALL_DIR/scripts/pre-commit"

# ---------- Install git hooks ----------
if [ -d "$INSTALL_DIR/.git" ]; then
  echo -e "${CYAN}[*] Installing git hooks...${NC}"
  "$INSTALL_DIR/scripts/install-hooks.sh" || true
fi

# ---------- Done ----------
echo ""
echo -e "${GREEN}=================================="
echo -e "  Installation complete!"
echo -e "==================================${NC}"
echo ""
echo -e "  Location: ${BOLD}${INSTALL_DIR}${NC}"
echo ""
echo -e "${CYAN}[*] Next steps:${NC}"
echo "    • Set your NanoGPT API key in the app Settings"
echo "    • To update later: cd $INSTALL_DIR && ./update.sh"
echo ""

# Offer to start the server immediately
printf "Start the server now? [Y/n] "
read -r LAUNCH_REPLY
echo ""
if [ -z "$LAUNCH_REPLY" ] || echo "$LAUNCH_REPLY" | grep -qi "^y"; then
  exec "$INSTALL_DIR/server.sh"
fi
