#!/usr/bin/env bash
# pre-commit-version-check.sh — Validate version consistency across all version files
# and run Node.js syntax checks on staged .js files.
# Install via: scripts/install-hooks.sh (or symlink manually to .git/hooks/pre-commit)

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# ---------- Syntax-check staged .js files ----------
check_staged_syntax() {
  local staged_js
  staged_js="$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null | grep '\.js$' || true)"
  if [ -z "$staged_js" ]; then
    return 0
  fi

  echo "JS syntax check (staged files):"
  local failed=false
  while IFS= read -r file; do
    # Use the staged content from the index, not the working-tree file.
    if git cat-file -e ":$file" 2>/dev/null; then
      local tmpfile
      tmpfile="$(mktemp "${REPO_ROOT}/.staged-js-XXXXXX.js")"
      if git show ":$file" >"$tmpfile" 2>&1; then
        if node --check "$tmpfile" 2>&1; then
          echo "  ✓ $file"
        else
          echo "  ✗ $file — syntax error (see above)"
          failed=true
        fi
      else
        echo "  ✗ $file — failed to read staged content"
        failed=true
      fi
      rm -f "$tmpfile"
    fi
  done < <(printf '%s\n' "$staged_js")

  if [ "$failed" = true ]; then
    echo ""
    echo "ERROR: One or more staged .js files have syntax errors. Fix them before committing."
    exit 1
  fi
}

check_staged_syntax

VERSION_JSON="$REPO_ROOT/public/version.json"
PACKAGE_JSON="$REPO_ROOT/package.json"
INDEX_HTML="$REPO_ROOT/index.html"

# ---------- Verify files exist ----------
for f in "$VERSION_JSON" "$PACKAGE_JSON" "$INDEX_HTML"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: expected file not found: $f" >&2
    exit 1
  fi
done

# ---------- Extract versions (non-fatal; validate after) ----------
VER_JSON="$(grep '"version"' "$VERSION_JSON" | head -1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)"
if [ -z "${VER_JSON:-}" ]; then
  echo 'ERROR: Could not extract version from version.json (missing "version" field?)' >&2
  exit 1
fi

VER_PKG="$(grep '"version"' "$PACKAGE_JSON" | head -1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)"
if [ -z "${VER_PKG:-}" ]; then
  echo 'ERROR: Could not extract version from package.json (missing "version" field?)' >&2
  exit 1
fi

VER_INDEX="$(grep -o 'v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]* \&middot; PWA' "$INDEX_HTML" | sed 's/^v\([^ ]*\) .*/\1/' || true)"
if [ -z "${VER_INDEX:-}" ]; then
  echo "ERROR: Could not extract version from index.html footer" >&2
  exit 1
fi

# ---------- Check consistency ----------
ALL_MATCH=true

check() {
  local label="$1"
  local ver="$2"
  if [ "$ver" != "$VER_JSON" ]; then
    echo "  ✗ $label: $ver  (expected $VER_JSON)"
    ALL_MATCH=false
  else
    echo "  ✓ $label: $ver"
  fi
}

echo "Version consistency check:"
echo "  ✓ version.json: $VER_JSON"
check "package.json" "$VER_PKG"
check "index.html (footer)" "$VER_INDEX"

if [ "$ALL_MATCH" = false ]; then
  echo ""
  echo "ERROR: Version mismatch detected. Run one of the following to fix:"
  echo "  ./scripts/bump-version.sh patch"
  echo "  ./scripts/bump-version.sh minor"
  echo "  ./scripts/bump-version.sh major"
  echo "  ./scripts/bump-version.sh <version>   # e.g. ./scripts/bump-version.sh $VER_JSON"
  exit 1
fi

exit 0
