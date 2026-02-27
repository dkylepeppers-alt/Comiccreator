#!/data/data/com.termux/files/usr/bin/bash
# ============================================
# AI Comic Creator - Termux Update Script
# ============================================
# Pulls the latest version from GitHub and
# invalidates the service worker cache.
#
# Usage:
#   chmod +x update.sh
#   ./update.sh
# ============================================

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# ANSI colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No color

echo ""
echo -e "${BOLD}=================================="
echo -e "  AI Comic Creator - Updater"
echo -e "==================================${NC}"
echo ""

# Check for git
if ! command -v git &> /dev/null; then
  echo -e "${YELLOW}[*] Git not found. Installing...${NC}"
  pkg install -y git 2>/dev/null || apt install -y git 2>/dev/null
  if ! command -v git &> /dev/null; then
    echo -e "${RED}[!] Could not install git. Please install it manually:${NC}"
    echo "    pkg install git"
    exit 1
  fi
fi

# Verify we're in a git repo
if [ ! -d "$DIR/.git" ]; then
  echo -e "${RED}[!] This directory is not a git repository.${NC}"
  echo "    Please clone the repo first:"
  echo "    git clone https://github.com/dkylepeppers-alt/Comiccreator.git"
  exit 1
fi

# Read current version
get_version() {
  if [ -f "$DIR/version.json" ]; then
    grep '"version"' "$DIR/version.json" | tr -d ' ",' | cut -d: -f2
  else
    echo "unknown"
  fi
}

CURRENT_VERSION=$(get_version)
echo -e "${CYAN}[*] Current version: v${CURRENT_VERSION}${NC}"

# Detect default branch
DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "")
if [ -z "$DEFAULT_BRANCH" ]; then
  # Try common branch names
  for branch in master main; do
    if git rev-parse --verify "origin/$branch" &>/dev/null; then
      DEFAULT_BRANCH="$branch"
      break
    fi
  done
fi

if [ -z "$DEFAULT_BRANCH" ]; then
  echo -e "${RED}[!] Could not detect default branch.${NC}"
  echo "    Try: git remote set-head origin --auto"
  exit 1
fi

echo -e "${CYAN}[*] Tracking branch: ${DEFAULT_BRANCH}${NC}"

# Stash any local changes
STASHED=false
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  echo -e "${YELLOW}[*] Stashing local changes...${NC}"
  git stash push -m "update.sh auto-stash $(date +%Y%m%d-%H%M%S)" && STASHED=true
fi

# Fetch latest from remote
echo -e "${CYAN}[*] Fetching latest changes...${NC}"
if ! git fetch origin "$DEFAULT_BRANCH" 2>&1; then
  echo -e "${RED}[!] Network error: could not reach the remote repository.${NC}"
  echo "    Check your internet connection and try again."
  if [ "$STASHED" = true ]; then
    echo -e "${YELLOW}[*] Restoring stashed changes...${NC}"
    git stash pop
  fi
  exit 1
fi

# Compare local vs remote
LOCAL_HEAD=$(git rev-parse HEAD)
REMOTE_HEAD=$(git rev-parse "origin/$DEFAULT_BRANCH")

if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
  echo ""
  echo -e "${GREEN}[+] Already up to date! (v${CURRENT_VERSION})${NC}"
  if [ "$STASHED" = true ]; then
    echo -e "${YELLOW}[*] Restoring stashed changes...${NC}"
    git stash pop
  fi
  echo ""
  exit 0
fi

# Count commits behind
BEHIND=$(git rev-list --count HEAD.."origin/$DEFAULT_BRANCH" 2>/dev/null || echo "?")
echo -e "${YELLOW}[*] ${BEHIND} new commit(s) available. Pulling...${NC}"

# Pull changes
if ! git pull origin "$DEFAULT_BRANCH" 2>&1; then
  echo ""
  echo -e "${RED}[!] Merge conflict detected.${NC}"
  echo "    To resolve manually:"
  echo "      1. Fix conflicts in the listed files"
  echo "      2. Run: git add . && git commit"
  echo "    Or to discard local changes and force update:"
  echo "      git reset --hard origin/$DEFAULT_BRANCH"
  if [ "$STASHED" = true ]; then
    echo ""
    echo -e "${YELLOW}[*] Your stashed changes are preserved.${NC}"
    echo "    Restore with: git stash pop"
  fi
  exit 1
fi

# Restore stashed changes
if [ "$STASHED" = true ]; then
  echo -e "${YELLOW}[*] Restoring stashed changes...${NC}"
  if ! git stash pop 2>/dev/null; then
    echo -e "${YELLOW}[!] Could not auto-restore stashed changes (conflict).${NC}"
    echo "    Your changes are saved. Restore with: git stash pop"
  fi
fi

# Show new version
NEW_VERSION=$(get_version)

# Bump service worker cache to force refresh
SW_FILE="$DIR/sw.js"
if [ -f "$SW_FILE" ]; then
  # Replace the CACHE_NAME value with one based on the new version number
  if grep -q "const CACHE_NAME" "$SW_FILE"; then
    sed -i "s/const CACHE_NAME = '.*'/const CACHE_NAME = 'comic-creator-v${NEW_VERSION}'/" "$SW_FILE"
    echo -e "${CYAN}[*] Service worker cache invalidated (comic-creator-v${NEW_VERSION})${NC}"
  fi
fi

echo ""
echo -e "${GREEN}=================================="
echo -e "  Update complete!"
echo -e "==================================${NC}"
echo ""
echo -e "  ${BOLD}v${CURRENT_VERSION}${NC} -> ${GREEN}${BOLD}v${NEW_VERSION}${NC}"
echo ""
echo -e "${CYAN}[*] Next steps:${NC}"
echo "    1. Restart the server:  ./server.sh"
echo "    2. Hard-refresh your browser (Ctrl+Shift+R)"
echo "       or clear the browser's site data"
echo ""
