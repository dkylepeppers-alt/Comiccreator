#!/usr/bin/env bash
# bump-version.sh — Atomically update version across all version files.
#
# After the Vite migration, the version lives in 3 source files:
#   - public/version.json  (read at build time by vite.config.js for __APP_VERSION__)
#   - package.json         (npm standard)
#   - index.html           (sidebar footer display)
# The service worker version is handled automatically by Workbox (vite-plugin-pwa),
# and settings.js APP_VERSION is injected by Vite's define plugin at build time.
# package-lock.json is also updated to stay consistent.
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

VERSION_JSON="$REPO_ROOT/public/version.json"
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
sed_i "s/\"version\":[[:space:]]*\"[^\"]*\"/\"version\": \"$NEW\"/" "$VERSION_JSON"
sed_i "s/\"updated\":[[:space:]]*\"[^\"]*\"/\"updated\": \"$TODAY\"/" "$VERSION_JSON"
echo "  Updated: public/version.json"

# ---------- Update package.json ----------
sed_i "s/\"version\":[[:space:]]*\"[^\"]*\"/\"version\": \"$NEW\"/" "$PACKAGE_JSON"
echo "  Updated: package.json"

# ---------- Update package-lock.json ----------
if [ -f "$PACKAGE_LOCK_JSON" ]; then
  LOCK_TMP="$(mktemp)"
  jq --arg v "$NEW" '.version = $v | .packages[""].version = $v' "$PACKAGE_LOCK_JSON" > "$LOCK_TMP"
  mv "$LOCK_TMP" "$PACKAGE_LOCK_JSON"
  echo "  Updated: package-lock.json"
fi

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
verify_contains "$PACKAGE_JSON"       "\"version\": \"$NEW\""                       "package.json"
verify_contains "$INDEX_HTML"         "v$NEW &middot; PWA"                          "index.html"

verify_not_contains "$VERSION_JSON"       "\"version\": \"$CURRENT\""               "version.json"
verify_not_contains "$PACKAGE_JSON"       "\"version\": \"$CURRENT\""               "package.json"
verify_not_contains "$INDEX_HTML"         "v$CURRENT &middot; PWA"                  "index.html"

if [ "$VERIFY_FAILED" -ne 0 ]; then
  echo "" >&2
  echo "Version bump INCOMPLETE — one or more files were not updated correctly." >&2
  echo "Fix the above errors manually and try again." >&2
  exit 1
fi

echo "  All files verified at version $NEW."

# ---------- Stage the changed files ----------
git -C "$REPO_ROOT" add \
  "$VERSION_JSON" \
  "$PACKAGE_JSON" \
  "$INDEX_HTML"

# Stage package-lock.json if it exists
if [ -f "$PACKAGE_LOCK_JSON" ]; then
  git -C "$REPO_ROOT" add "$PACKAGE_LOCK_JSON"
fi

echo ""
echo "Done. Version bumped to $NEW (updated: $TODAY)"
echo "Staged files are ready to commit."
