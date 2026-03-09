#!/usr/bin/env bash
# update-docs.sh — Regenerate auto-generated sections of README.md.
#
# Sections delimited by AUTO-GENERATED-CONTENT markers are replaced with
# freshly-generated content.  Everything outside the markers is untouched.
#
# Requirements: bash ≥ 4, awk, sed, find.
#
# Usage:
#   bash scripts/update-docs.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
README="$REPO_ROOT/README.md"

# Clean up temp files on exit
cleanup_files=()
trap 'rm -f "${cleanup_files[@]}"' EXIT

# ──── Helpers ────────────────────────────────────────────────────────

# Replace the content between AUTO-GENERATED-CONTENT markers for a given
# section name.  Takes the marker name and a file whose contents will be
# inserted between the markers.
replace_section() {
  local marker="$1"
  local content_file="$2"
  local target="$3"

  local start_tag="<!-- AUTO-GENERATED-CONTENT:START (${marker}) -->"
  local end_tag="<!-- AUTO-GENERATED-CONTENT:END (${marker}) -->"

  if ! grep -qF "$start_tag" "$target"; then
    echo "  Warning: start marker for $marker not found in $(basename "$target") — skipping" >&2
    return
  fi
  if ! grep -qF "$end_tag" "$target"; then
    echo "  Error: end marker for $marker not found in $(basename "$target")" >&2
    return 1
  fi

  # Use awk to splice content_file between the markers
  awk -v cf="$content_file" -v marker="$marker" '
    BEGIN { skip = 0 }
    index($0, "AUTO-GENERATED-CONTENT:START (" marker ")") {
      print
      while ((getline line < cf) > 0) print line
      close(cf)
      skip = 1
      next
    }
    index($0, "AUTO-GENERATED-CONTENT:END (" marker ")") {
      print
      skip = 0
      next
    }
    !skip { print }
  ' "$target" > "${target}.tmp" && mv "${target}.tmp" "$target"
}

# ──── Generate directory tree ────────────────────────────────────────

generate_tree() {
  cd "$REPO_ROOT"

  echo '```'
  echo 'Comiccreator/'

  # Deterministic, portable directory listing using find.
  # Always uses find (never tree) so output is identical across CI and local.
  find . \
    -path './node_modules' -prune -o \
    -path './test-results' -prune -o \
    -path './playwright-report' -prune -o \
    -path './.git' -prune -o \
    \( -type f -o -type d \) -print \
  | sed 's|^\./||' \
  | sed '/^\.$/d' \
  | sort \
  | awk '{
      n = split($0, parts, "/")
      indent = ""
      for (i = 1; i < n; i++) indent = indent "    "
      name = parts[n]
      print indent name
    }'

  echo '```'
}

# ──── Generate CI workflows table ────────────────────────────────────

generate_workflows_table() {
  echo '| Workflow | Trigger | Description |'
  echo '|----------|---------|-------------|'

  for f in "$REPO_ROOT"/.github/workflows/*.yml "$REPO_ROOT"/.github/workflows/*.yaml; do
    [ -f "$f" ] || continue

    local file
    file="$(basename "$f")"

    # Extract workflow name
    local name
    name="$(grep -m1 '^name:' "$f" \
      | sed 's/^name:[[:space:]]*//' \
      | sed "s/^[\"']\(.*\)[\"']$/\1/")"

    # Extract trigger types from the on: block
    local triggers=""
    local in_on=0
    while IFS= read -r line; do
      # Detect the start of the on: block
      if printf '%s\n' "$line" | grep -qE '^on:'; then
        in_on=1
        # Handle inline form:  on: push
        local inline
        inline="$(printf '%s\n' "$line" | sed -n 's/^on:[[:space:]]*\([a-z_]*\).*/\1/p')"
        if [ -n "$inline" ]; then
          triggers="$inline"
          break
        fi
        # Handle bracket form:  on: [push, pull_request]
        local bracket
        bracket="$(printf '%s\n' "$line" | sed -n 's/^on:[[:space:]]*\[//p' | tr -d '[]' | sed 's/,  */, /g' | sed 's/[[:space:]]*$//')"
        if [ -n "$bracket" ]; then
          triggers="$bracket"
          break
        fi
        continue
      fi
      if [ "$in_on" -eq 1 ]; then
        # A non-indented line means we left the on: block
        if printf '%s\n' "$line" | grep -qE '^[a-z#]'; then
          break
        fi
        # Capture top-level trigger keys (indented directly under on:)
        local trigger
        trigger="$(printf '%s\n' "$line" | sed -n 's/^  \([a-z_-]*\):.*/\1/p')"
        if [ -n "$trigger" ]; then
          [ -n "$triggers" ] && triggers="$triggers, $trigger" || triggers="$trigger"
        fi
      fi
    done < "$f"

    echo "| \`$file\` | ${triggers:--} | ${name:-$file} |"
  done
}

# ──── Generate agent roster table ────────────────────────────────────

# Extract a scalar field from YAML frontmatter (between the first two --- markers).
# Usage: extract_frontmatter_field <field> <file>
extract_frontmatter_field() {
  local field="$1"
  local file="$2"
  awk -v field="$field" '
    /^---/{ if(++fm==2) exit }
    fm==1 && $0 ~ "^" field ":" {
      sub("^" field ":[[:space:]]*", "")
      gsub(/^["'"'"']|["'"'"']$/, "")
      print
      exit
    }
  ' "$file"
}

generate_agent_roster() {
  echo '| Agent | Name | Description |'
  echo '|-------|------|-------------|'

  # Collect agent files then sort explicitly for deterministic ordering.
  local agent_files=()
  for f in "$REPO_ROOT"/.github/agents/*.agent.md; do
    [ -f "$f" ] || continue
    agent_files+=("$f")
  done

  if [ "${#agent_files[@]}" -eq 0 ]; then
    return
  fi

  local sorted_files=()
  while IFS= read -r line; do
    sorted_files+=("$line")
  done < <(printf '%s\n' "${agent_files[@]}" | LC_ALL=C sort)

  local f
  for f in "${sorted_files[@]}"; do
    local file
    file="$(basename "$f" .agent.md)"

    local agent_name
    agent_name="$(extract_frontmatter_field "name" "$f")"
    [ -z "$agent_name" ] && agent_name="$file"

    local desc
    desc="$(extract_frontmatter_field "description" "$f")"

    echo "| \`$file\` | $agent_name | $desc |"
  done
}


# ──── Main ───────────────────────────────────────────────────────────

echo "Updating README.md auto-generated sections..."

# Directory tree
TREE_TMP="$(mktemp)"
cleanup_files+=("$TREE_TMP")
generate_tree > "$TREE_TMP"
replace_section "DIRECTORY_TREE" "$TREE_TMP" "$README"
echo "  ✓ Directory tree"

# CI workflows table
WF_TMP="$(mktemp)"
cleanup_files+=("$WF_TMP")
generate_workflows_table > "$WF_TMP"
replace_section "WORKFLOWS_TABLE" "$WF_TMP" "$README"
echo "  ✓ CI workflows table"

# Agent roster table
AGENT_TMP="$(mktemp)"
cleanup_files+=("$AGENT_TMP")
generate_agent_roster > "$AGENT_TMP"
replace_section "AGENT_ROSTER" "$AGENT_TMP" "$README"
echo "  ✓ Agent roster"

echo ""
echo "Done. README.md updated."
