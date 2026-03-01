#!/usr/bin/env bash
# install-hooks.sh — Install git hooks from the scripts/ directory.
# Run once after cloning, or automatically via `npm install` (prepare script).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS_DIR="$REPO_ROOT/scripts"

# Ensure we're inside a git repository (handles worktrees and submodules)
if ! git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  echo "No git repository found at $REPO_ROOT — skipping hook installation."
  exit 0
fi

# Resolve the hooks directory via git to support worktrees/submodules
HOOKS_DIR="$(git -C "$REPO_ROOT" rev-parse --git-path hooks 2>/dev/null || echo "$REPO_ROOT/.git/hooks")"
mkdir -p "$HOOKS_DIR"

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
