#!/usr/bin/env bash
# bump-version.sh — Atomically update version across all version files.
#
# Updates: version.json, sw.js, js/pages/settings.js, package.json,
#          package-lock.json (root + packages[""].version), and index.html.
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
PACKAGE_LOCK_JSON="$REPO_ROOT/package-lock.json"
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

# ---------- Update package-lock.json ----------
# Update root "version" and packages[""].version using jq to avoid touching
# dependency version fields elsewhere in the lockfile.
LOCK_TMP="$(mktemp)"
jq --arg v "$NEW" '.version = $v | .packages[""].version = $v' "$PACKAGE_LOCK_JSON" > "$LOCK_TMP"
mv "$LOCK_TMP" "$PACKAGE_LOCK_JSON"
echo "  Updated: package-lock.json"

# ---------- Update index.html footer ----------
sed_i "s/v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]* \&middot; PWA/v$NEW \&middot; PWA/" "$INDEX_HTML"
echo "  Updated: index.html"

# ---------- Verify all files were updated ----------
VERIFY_FAILED=0

verify_contains() {
  local file="$1"
  local pattern="$2"
  local label="$3"
  if ! grep -q "$pattern" "$file"; then
    echo "ERROR: $label still does not contain expected version string '$pattern'" >&2
    VERIFY_FAILED=1
  fi
}

verify_not_contains() {
  local file="$1"
  local pattern="$2"
  local label="$3"
  if grep -q "$pattern" "$file"; then
    echo "ERROR: $label still contains old version string '$pattern'" >&2
    VERIFY_FAILED=1
  fi
}

echo ""
echo "Verifying updates..."

verify_contains "$VERSION_JSON"       "\"version\": \"$NEW\""                      "version.json"
verify_contains "$SW_JS"              "comic-creator-v$NEW"                         "sw.js"
verify_contains "$SETTINGS_JS"        "APP_VERSION = '$NEW'"                        "js/pages/settings.js"
verify_contains "$PACKAGE_JSON"       "\"version\": \"$NEW\""                       "package.json"
verify_contains "$PACKAGE_LOCK_JSON"  "\"version\": \"$NEW\""                       "package-lock.json"
verify_contains "$INDEX_HTML"         "v$NEW &middot; PWA"                          "index.html"

verify_not_contains "$VERSION_JSON"       "\"version\": \"$CURRENT\""               "version.json"
verify_not_contains "$SW_JS"              "comic-creator-v$CURRENT"                 "sw.js"
verify_not_contains "$SETTINGS_JS"        "APP_VERSION = '$CURRENT'"                "js/pages/settings.js"
verify_not_contains "$PACKAGE_JSON"       "\"version\": \"$CURRENT\""               "package.json"
verify_not_contains "$INDEX_HTML"         "v$CURRENT &middot; PWA"                  "index.html"

if [ "$VERIFY_FAILED" -ne 0 ]; then
  echo "" >&2
  echo "Version bump INCOMPLETE — one or more files were not updated correctly." >&2
  echo "Fix the above errors manually and try again." >&2
  exit 1
fi

echo "  All 6 files verified at version $NEW."

# ---------- Stage the changed files ----------
git -C "$REPO_ROOT" add \
  "$VERSION_JSON" \
  "$SW_JS" \
  "$SETTINGS_JS" \
  "$PACKAGE_JSON" \
  "$PACKAGE_LOCK_JSON" \
  "$INDEX_HTML"

echo ""
echo "Done. Version bumped to $NEW (updated: $TODAY)"
echo "Staged files are ready to commit."
