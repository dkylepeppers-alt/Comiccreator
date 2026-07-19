#!/usr/bin/env bash
# validate-workflows.sh — Validate GitHub Actions workflow files for required
# security and correctness conventions.
#
# Checks performed:
#   1. Every workflow file has a `permissions:` block (job-level or top-level)
#   2. Workflows that push commits to Main have bot loop guards
#      (github.actor != 'github-actions[bot]')
#   3. Workflows that push commits to Main have a `concurrency:` group
#
# Usage:
#   bash scripts/validate-workflows.sh
#   npm run validate:workflows

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOWS_DIR="$REPO_ROOT/.github/workflows"

if [ ! -d "$WORKFLOWS_DIR" ]; then
  echo "No .github/workflows directory found at $REPO_ROOT — nothing to validate."
  exit 0
fi

ERRORS=0
WARNINGS=0

error() {
  echo "  ✗ ERROR: $1"
  ERRORS=$((ERRORS + 1))
}

warn() {
  echo "  ⚠ WARN:  $1"
  WARNINGS=$((WARNINGS + 1))
}

ok() {
  echo "  ✓ $1"
}

echo "Validating workflow files in $WORKFLOWS_DIR..."
echo ""

for f in "$WORKFLOWS_DIR"/*.yml "$WORKFLOWS_DIR"/*.yaml; do
  [ -f "$f" ] || continue
  file="$(basename "$f")"
  echo "── $file"

  # ── Check 1: permissions block present (top-level or job-level) ─────────
  if grep -q '^permissions:' "$f" || grep -qE '^    permissions:' "$f"; then
    ok "has permissions block"
  else
    error "$file: missing 'permissions:' block (add job-level or top-level permissions)"
  fi

  # ── Check 2: bot loop guard on auto-commit workflows ────────────────────
  # Detect workflows that commit/push: look for git push/commit on non-comment lines.
  # Bot loop guards are only needed for push/schedule-triggered workflows — a
  # workflow_dispatch-only workflow cannot be re-triggered by a bot commit.
  if grep -qE "^[[:space:]]*[^#].*git (push|commit)" "$f"; then
    is_push_triggered=false
    if grep -qE "^  (push|schedule|pull_request):" "$f"; then
      is_push_triggered=true
    fi

    if [ "$is_push_triggered" = true ]; then
      # Require an explicit guard on an if: line, e.g.:
      #   if: github.actor != 'github-actions[bot]'
      if grep -qE "^[[:space:]]*if:.*github\.actor[[:space:]]*!=[[:space:]]*['\"]github-actions\[bot\]['\"]" "$f"; then
        ok "has bot loop guard (if: github.actor != 'github-actions[bot]')"
      else
        error "$file: push-triggered auto-commit workflow is missing bot loop guard for 'github-actions[bot]'"
      fi
    fi
  fi

  # ── Check 3: concurrency group on default-branch-push workflows ─────────
  # Detect workflows triggered on push to the default branch by looking for the
  # branch listed inside a branches: array or block (e.g. `- main` or
  # `branches: [main]`). Legacy names stay matched so a rename can't silently
  # exempt a workflow from the check.
  if grep -qiE "^[[:space:]]+-[[:space:]]+['\"]?(main|broke)['\"]?[[:space:]]*$" "$f" || \
     grep -qiE "branches:[[:space:]]*\[['\"]?(main|broke)['\"]?\]" "$f"; then
    if grep -q '^concurrency:' "$f"; then
      ok "has concurrency group"
    else
      warn "$file: workflow targeting the default branch should have a 'concurrency:' group to prevent race conditions"
    fi
  fi

  echo ""
done

echo "──────────────────────────────────────────"
if [ "$ERRORS" -gt 0 ]; then
  echo "Result: $ERRORS error(s), $WARNINGS warning(s) — FAILED"
  exit 1
elif [ "$WARNINGS" -gt 0 ]; then
  echo "Result: 0 errors, $WARNINGS warning(s) — passed with warnings"
  exit 0
else
  echo "Result: all checks passed ✓"
  exit 0
fi
