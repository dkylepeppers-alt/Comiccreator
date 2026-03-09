#!/usr/bin/env bash
# check-actions.sh — Lint all GitHub Actions workflow YAML files using actionlint.
#
# actionlint is optional/advisory: if it is not installed the script prints a
# hint and exits 0 so it never blocks CI or local development when the tool is
# absent.  Install it with:
#   brew install actionlint          # macOS
#   go install github.com/rhysd/actionlint/cmd/actionlint@latest   # Go
#   # or download a binary from https://github.com/rhysd/actionlint/releases
#
# Usage:
#   bash scripts/check-actions.sh            # lint all workflow files
#   npm run lint:actions

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOWS_DIR="$REPO_ROOT/.github/workflows"

if ! command -v actionlint >/dev/null 2>&1; then
  echo "actionlint is not installed — skipping workflow lint."
  echo "  Install: https://github.com/rhysd/actionlint#installation"
  exit 0
fi

if [ ! -d "$WORKFLOWS_DIR" ]; then
  echo "No .github/workflows directory found at $REPO_ROOT — nothing to lint."
  exit 0
fi

workflow_files=()
while IFS= read -r f; do
  workflow_files+=("$f")
done < <(find "$WORKFLOWS_DIR" -maxdepth 1 \( -name '*.yml' -o -name '*.yaml' \) -print | sort)

if [ "${#workflow_files[@]}" -eq 0 ]; then
  echo "No workflow files found in $WORKFLOWS_DIR."
  exit 0
fi

echo "Linting ${#workflow_files[@]} workflow file(s) with actionlint..."
actionlint "${workflow_files[@]}"
echo "  ✓ All workflow files passed actionlint checks."
