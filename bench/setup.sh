#!/bin/sh
# Create two identical copies of the bookshelf benchmark repo: one for Claude Code, one for Ensemble.
# Usage: bench/setup.sh [target-dir]      (default: ~/Projects/ensemble-bench)
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="${1:-$HOME/Projects/ensemble-bench}"

if [ -e "$DIR/claude-code" ] || [ -e "$DIR/ensemble" ]; then
  echo "$DIR already has a benchmark. Remove it first (or pass another folder)." >&2
  exit 1
fi

for side in claude-code ensemble; do
  repo="$DIR/$side/bookshelf"
  mkdir -p "$repo"
  cp -R "$HERE/seed/." "$repo/"
  (
    cd "$repo"
    git init -q -b main
    git add -A
    # Fixed identity + dates so both repos start from the exact same commit hash.
    GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z" \
      git -c user.name=bench -c user.email=bench@local commit -q -m "bookshelf: starting point"
  )
done
cp "$HERE/PROMPT.md" "$DIR/PROMPT.md"

BASE=$(git -C "$DIR/ensemble/bookshelf" rev-parse --short HEAD)
cat <<MSG
Benchmark ready in $DIR  (both repos at commit $BASE)

  Claude Code:  cd "$DIR/claude-code/bookshelf" && claude      → paste the contents of $DIR/PROMPT.md
  Ensemble:     open the dashboard → Open a project → $DIR/ensemble/bookshelf → paste the same prompt → Start run
                (the folder must be under an allowed root — Settings → Folders)

When both are finished (Ensemble: approve the tasks you'd merge):
  $HERE/score.sh "$DIR/claude-code/bookshelf"
  $HERE/score.sh "$DIR/ensemble/bookshelf"
MSG
