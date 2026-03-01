#!/usr/bin/env bash
# install-hooks.sh — Install git hooks from the scripts/ directory.
# Run once after cloning, or automatically via `npm install` (prepare script).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"
SCRIPTS_DIR="$REPO_ROOT/scripts"

if [ ! -d "$REPO_ROOT/.git" ]; then
  echo "No .git directory found — skipping hook installation."
  exit 0
fi

install_hook() {
  local name="$1"
  local src="$SCRIPTS_DIR/$name"
  local dest="$HOOKS_DIR/$name"

  if [ ! -f "$src" ]; then
    echo "Warning: $src not found — skipping."
    return
  fi

  chmod +x "$src"

  if [ -L "$dest" ] || [ -f "$dest" ]; then
    # Overwrite only if it already points to our script or is our script
    if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
      echo "  Hook already installed: $name"
      return
    fi
    if ! cp "$dest" "${dest}.bak" 2>/dev/null; then
      echo "  Warning: could not back up existing $name hook — it will be overwritten."
    fi
  fi

  ln -sf "$src" "$dest"
  echo "  Installed hook: $name -> $src"
}

echo "Installing git hooks..."
install_hook pre-commit
echo "Done."
