#!/usr/bin/env bash
# scripts/update-docs.sh
#
# Called by .github/workflows/auto-update-docs.yml on every non-bot push to Main.
#
# What it does:
#   1. Adds an entry for the latest commit / merged PR to CHANGELOG.md.
#   2. Syncs any stale version numbers inside docs/*.md when the app version changed.
#   3. Ensures the README.md CI-workflows table lists the auto-update-docs workflow.
#
# Nothing is committed here; the calling workflow handles git add / commit / push.

set -euo pipefail

# ─── Gather commit context ──────────────────────────────────────────────────
COMMIT_MSG="${COMMIT_MESSAGE:-$(git log -1 --format='%s')}"
COMMIT_BODY=$(git log -1 --format='%b' | head -5)
COMMIT_AUTHOR="${ACTOR:-$(git log -1 --format='%an')}"
COMMIT_DATE=$(date -u '+%Y-%m-%d')
COMMIT_HASH=$(git log -1 --format='%h')
CURRENT_VERSION=$(node -p "require('./package.json').version")

echo "==> update-docs: commit=${COMMIT_HASH}  version=${CURRENT_VERSION}"
echo "    msg:    ${COMMIT_MSG}"
echo "    author: ${COMMIT_AUTHOR}"

# ─── 1. Update CHANGELOG.md ─────────────────────────────────────────────────
CHANGELOG="CHANGELOG.md"

# Create CHANGELOG.md if it does not yet exist.
if [ ! -f "$CHANGELOG" ]; then
  cat > "$CHANGELOG" <<'EOF'
# Changelog

All notable changes to the AI Comic Creator are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---
EOF
  echo "==> Created ${CHANGELOG}"
fi

# Build the human-readable entry text.
# GitHub creates merge commits like: "Merge pull request #42 from owner/branch"
# The actual PR title appears on the second line of that commit body.
if echo "$COMMIT_MSG" | grep -qE '^Merge pull request #[0-9]+'; then
  PR_NUM=$(echo "$COMMIT_MSG" | grep -oE '#[0-9]+')
  PR_TITLE=$(echo "$COMMIT_BODY" | head -1)
  [ -z "$PR_TITLE" ] && PR_TITLE="$COMMIT_MSG"
  ENTRY="- ${PR_TITLE} (${PR_NUM}, @${COMMIT_AUTHOR}, ${COMMIT_DATE})"
else
  ENTRY="- ${COMMIT_MSG} (@${COMMIT_AUTHOR}, ${COMMIT_DATE})"
fi

VERSION_HEADER="## [${CURRENT_VERSION}]"

# Use Python (always available in GitHub-hosted runners) for reliable in-place
# editing that avoids cross-platform sed -i differences.

if grep -qF "${VERSION_HEADER}" "$CHANGELOG"; then
  # A section for this version already exists — insert the new entry right after
  # the header, skipping any blank line that immediately follows it.
  python3 - "$CHANGELOG" "$VERSION_HEADER" "$ENTRY" <<'PYEOF'
import sys

path, header, entry = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path).readlines()
out = []
i = 0
while i < len(lines):
    out.append(lines[i])
    # Match header prefix — the stored line may have a " — YYYY-MM-DD" suffix
    if lines[i].strip().startswith(header):
        i += 1
        # Preserve any blank line immediately after the header
        while i < len(lines) and lines[i].strip() == '':
            out.append(lines[i])
            i += 1
        # Only insert if a duplicate entry doesn't already exist within this
        # version section (scan forward until the next version header or EOF).
        existing = []
        j = i
        while j < len(lines) and not lines[j].strip().startswith('## ['):
            if lines[j].startswith('- '):
                existing.append(lines[j].rstrip())
            j += 1
        if entry.rstrip() not in existing:
            out.append(entry + '\n')
        continue
    i += 1
open(path, 'w').writelines(out)
PYEOF
else
  # No section for this version yet — prepend one right after the first "---" divider.
  python3 - "$CHANGELOG" "$VERSION_HEADER" "$ENTRY" "$COMMIT_DATE" <<'PYEOF'
import sys

path, header, entry, date = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
lines = open(path).readlines()
out = []
inserted = False
for line in lines:
    out.append(line)
    if not inserted and line.strip() == '---':
        out.append('\n')
        out.append(f'{header} — {date}\n')
        out.append('\n')
        out.append(entry + '\n')
        out.append('\n')
        inserted = True
if not inserted:
    out.append(f'\n{header} — {date}\n\n{entry}\n')
open(path, 'w').writelines(out)
PYEOF
fi

echo "==> Updated ${CHANGELOG}"

# ─── 2. Sync version numbers inside docs/ ───────────────────────────────────
# Detect the version that was current in the commit immediately before this one.
PREV_COMMIT=$(git log -2 --format='%H' | tail -1)
PREV_VERSION=$(git show "${PREV_COMMIT}:package.json" 2>/dev/null \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['version'])" 2>/dev/null \
  || true)

if [ -n "$PREV_VERSION" ] && [ "$PREV_VERSION" != "$CURRENT_VERSION" ]; then
  echo "==> Version changed ${PREV_VERSION} → ${CURRENT_VERSION}; syncing docs/"
  for f in docs/*.md; do
    [ -f "$f" ] || continue
    if grep -qF "v${PREV_VERSION}" "$f"; then
      # Use Python for reliable cross-platform in-place editing
      python3 - "$f" "v${PREV_VERSION}" "v${CURRENT_VERSION}" <<'PYEOF'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
content = open(path).read()
open(path, 'w').write(content.replace(old, new))
PYEOF
      echo "==> Synced version in ${f}"
    fi
  done
fi

# ─── 3. Keep README CI-workflows table up to date ───────────────────────────
README="README.md"
DOC_ROW='| `auto-update-docs.yml` | Push to `Main` (non-bot) | Updates CHANGELOG and syncs version refs in docs |'

if [ -f "$README" ] && ! grep -qF 'auto-update-docs.yml' "$README"; then
  # Insert the row immediately after the auto-bump.yml row.
  python3 - "$README" "$DOC_ROW" <<'PYEOF'
import sys

path, row = sys.argv[1], sys.argv[2]
lines = open(path).readlines()
out = []
for line in lines:
    out.append(line)
    if '`auto-bump.yml`' in line and row not in line:
        out.append(row + '\n')
open(path, 'w').writelines(out)
PYEOF
  echo "==> Added auto-update-docs.yml row to README CI table"
fi

echo "==> update-docs complete"
