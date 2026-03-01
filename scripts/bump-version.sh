#!/usr/bin/env bash
# bump-version.sh — Atomically update version across all 4 version files.
#
# Usage:
#   ./scripts/bump-version.sh patch        # 1.2.3 -> 1.2.4
#   ./scripts/bump-version.sh minor        # 1.2.3 -> 1.3.0
#   ./scripts/bump-version.sh major        # 1.2.3 -> 2.0.0
#   ./scripts/bump-version.sh 2.0.0        # explicit version

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Portable in-place sed (GNU sed uses -i, macOS sed requires -i '')
sed_i() {
  if sed --version 2>/dev/null | grep -q GNU; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

VERSION_JSON="$REPO_ROOT/version.json"
SW_JS="$REPO_ROOT/sw.js"
SETTINGS_JS="$REPO_ROOT/js/pages/settings.js"
PACKAGE_JSON="$REPO_ROOT/package.json"
INDEX_HTML="$REPO_ROOT/index.html"

# ---------- Read current version ----------
if [ ! -f "$VERSION_JSON" ]; then
  echo "Error: version.json not found at $VERSION_JSON" >&2
  exit 1
fi

CURRENT="$(grep '"version"' "$VERSION_JSON" | head -1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)"
if [ -z "$CURRENT" ]; then
  echo "Error: could not read current version from version.json (missing \"version\" field)" >&2
  exit 1
fi

if ! printf '%s\n' "$CURRENT" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Error: version.json contains an invalid version \"$CURRENT\" (expected MAJOR.MINOR.PATCH)" >&2
  exit 1
fi

MAJOR="$(echo "$CURRENT" | cut -d. -f1)"
MINOR="$(echo "$CURRENT" | cut -d. -f2)"
PATCH="$(echo "$CURRENT" | cut -d. -f3)"

# ---------- Calculate new version ----------
ARG="${1:-}"
if [ -z "$ARG" ]; then
  echo "Usage: $0 patch|minor|major|<version>" >&2
  exit 1
fi

case "$ARG" in
  patch)
    NEW="$MAJOR.$MINOR.$((PATCH + 1))"
    ;;
  minor)
    NEW="$MAJOR.$((MINOR + 1)).0"
    ;;
  major)
    NEW="$((MAJOR + 1)).0.0"
    ;;
  [0-9]*.[0-9]*.[0-9]*)
    NEW="$ARG"
    ;;
  *)
    echo "Error: argument must be 'patch', 'minor', 'major', or a semver string (e.g. 2.0.0)" >&2
    exit 1
    ;;
esac

TODAY="$(date +%Y-%m-%d)"

echo "Bumping version: $CURRENT -> $NEW"

# ---------- Update version.json ----------
# Replace "version": "..." and "updated": "..."
sed_i "s/\"version\":[[:space:]]*\"[^\"]*\"/\"version\": \"$NEW\"/" "$VERSION_JSON"
sed_i "s/\"updated\":[[:space:]]*\"[^\"]*\"/\"updated\": \"$TODAY\"/" "$VERSION_JSON"
echo "  Updated: version.json"

# ---------- Update sw.js CACHE_NAME ----------
sed_i "s/const CACHE_NAME = 'comic-creator-v[^']*'/const CACHE_NAME = 'comic-creator-v$NEW'/" "$SW_JS"
echo "  Updated: sw.js"

# ---------- Update settings.js APP_VERSION ----------
sed_i "s/const APP_VERSION = '[^']*'/const APP_VERSION = '$NEW'/" "$SETTINGS_JS"
echo "  Updated: js/pages/settings.js"

# ---------- Update package.json ----------
sed_i "s/\"version\":[[:space:]]*\"[^\"]*\"/\"version\": \"$NEW\"/" "$PACKAGE_JSON"
echo "  Updated: package.json"

# ---------- Update index.html footer ----------
sed_i "s/v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]* \&middot; PWA/v$NEW \&middot; PWA/" "$INDEX_HTML"
echo "  Updated: index.html"

# ---------- Stage the changed files ----------
git -C "$REPO_ROOT" add \
  "$VERSION_JSON" \
  "$SW_JS" \
  "$SETTINGS_JS" \
  "$PACKAGE_JSON" \
  "$INDEX_HTML"

echo ""
echo "Done. Version bumped to $NEW (updated: $TODAY)"
echo "Staged files are ready to commit."
