#!/bin/sh
# Score a finished bookshelf repo: its own tests + the hidden acceptance tests (run on a scratch copy).
# Usage: bench/score.sh <path-to-bookshelf-repo>
set -eu
[ $# -eq 1 ] || { echo "usage: $0 <path-to-bookshelf-repo>" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$1" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Score the working tree as-is (committed or not), never touching the original.
mkdir -p "$WORK/repo"
(cd "$REPO" && tar --exclude=.git --exclude=node_modules -cf - .) | (cd "$WORK/repo" && tar -xf -)

echo "━━ $REPO"
if git -C "$REPO" rev-parse -q --verify HEAD >/dev/null 2>&1; then
  ROOT_COMMIT=$(git -C "$REPO" rev-list --max-parents=0 HEAD | tail -1)
  echo "commits since start: $(git -C "$REPO" rev-list --count "$ROOT_COMMIT"..HEAD)   uncommitted files: $(git -C "$REPO" status --porcelain | wc -l | tr -d ' ')"
  git -C "$REPO" diff --shortstat "$ROOT_COMMIT" | sed 's/^/changes vs start:/'
fi

echo
echo "── repo's own tests (npm test)"
if (cd "$WORK/repo" && npm test >"$WORK/own.log" 2>&1); then OWN="passing"; else OWN="FAILING"; fi
OWN_PASS=$(grep -E '^ℹ pass ' "$WORK/own.log" | awk '{print $3}' | tail -1)
OWN_FAIL=$(grep -E '^ℹ fail ' "$WORK/own.log" | awk '{print $3}' | tail -1)
echo "$OWN — ${OWN_PASS:-?} passed, ${OWN_FAIL:-?} failed"

echo
echo "── hidden acceptance tests"
mkdir -p "$WORK/repo/test-acceptance"
cp "$HERE/acceptance/acceptance.test.js" "$WORK/repo/test-acceptance/"
(cd "$WORK/repo" && node --test --test-reporter=tap test-acceptance/acceptance.test.js >"$WORK/acc.tap" 2>&1) || true

awk '
  /^(not )?ok [0-9]+ - \[/ {
    passed = ($1 == "ok")
    match($0, /\[[a-z]+\]/); area = substr($0, RSTART + 1, RLENGTH - 2)
    name = $0; sub(/^(not )?ok [0-9]+ - /, "", name)
    total[area]++; all++
    if (passed) { pass[area]++; allpass++ } else { fails[++nf] = name }
    if (!(area in seen)) { seen[area] = 1; order[++na] = area }
  }
  END {
    for (i = 1; i <= na; i++) { a = order[i]; printf "  %-11s %2d / %-2d\n", a, pass[a] + 0, total[a] }
    printf "  %-11s %2d / %-2d  (%d%%)\n", "TOTAL", allpass + 0, all, all ? int(100 * allpass / all) : 0
    if (nf) { print "\n  failed:"; for (i = 1; i <= nf; i++) print "   ✗ " fails[i] }
  }
' "$WORK/acc.tap"

if ! grep -qE '^(not )?ok [0-9]+ - \[' "$WORK/acc.tap"; then
  echo "  (no results — the test file could not run)"; tail -20 "$WORK/acc.tap"
fi
