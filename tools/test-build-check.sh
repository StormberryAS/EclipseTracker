#!/usr/bin/env bash
# Proves that tools/build-ts.sh --check passes on this checkout and fails on each defect it exists to
# catch. Works on a throwaway copy (a new git repository with every file staged, nothing
# committed), so this checkout is never touched.
#
#   tools/test-build-check.sh
#
# Cases, each expected to FAIL the check, with the message it must print:
#   * a stray compiled file in core/ that no ts/ source compiles to (code review C-16)
#   * a stray compiled file beside app.js (C-16)
#   * a hand edit to a compiled file
#   * a source in ts/core/ that uses the DOM (code review C-17)
#   * a stale ?v= stamp
# and the untouched copy, expected to PASS. Prints one line per case; exits 1 on any surprise.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
copy="$work/EclipseTracker"
mkdir -p "$copy"
(cd "$ROOT" && git ls-files -co --exclude-standard -z | xargs -0 cp --parents -t "$copy")
cp -r "$ROOT/node_modules" "$copy/node_modules"
(cd "$copy" && git init -q && git add -A)

fails=0
expect() {
  # expect pass|fail "name" "message the output must contain (for fail)"
  local want="$1" name="$2" msg="${3:-}" out rc
  set +e
  out="$(cd "$copy" && tools/build-ts.sh --check 2>&1)"
  rc=$?
  set -e
  if [ "$want" = pass ] && [ "$rc" = 0 ]; then
    echo "ok   $name: passes"
  elif [ "$want" = fail ] && [ "$rc" != 0 ] && grep -qF -- "$msg" <<<"$out"; then
    echo "ok   $name: fails with \"$msg\""
  else
    echo "FAIL $name: exit $rc, wanted $want${msg:+ with \"$msg\"}"
    sed 's/^/     /' <<<"$out" | tail -15
    fails=1
  fi
}

expect pass "the copy as it is"

echo 'export const stray = 1;' > "$copy/core/stray.js"
expect fail "a stray core/stray.js" "core/stray.js is compiled JavaScript that no ts/ source compiles to"
rm "$copy/core/stray.js"

echo 'export const old = 1;' > "$copy/old-app.js"
expect fail "a stray old-app.js beside app.js" "old-app.js is compiled JavaScript that no ts/ source compiles to"
rm "$copy/old-app.js"

cp "$copy/core/ics.js" "$work/ics.js"
sed -i 's/PT0S/PT0M/' "$copy/core/ics.js"
expect fail "a hand edit to core/ics.js" "core/ics.js is NOT what ts/ compiles to"
cp "$work/ics.js" "$copy/core/ics.js"

echo "export const title = (): string => document.title;" > "$copy/ts/core/zz-dom.ts"
expect fail "ts/core/ using the DOM" "ts/core/ uses something only a browser has"
rm "$copy/ts/core/zz-dom.ts"

cp "$copy/index.html" "$work/index.html"
sed -i -E 's/app\.js\?v=[0-9a-f]{8}/app.js?v=00000000/' "$copy/index.html"
expect fail "a stale ?v= stamp on app.js" "index.html"
cp "$work/index.html" "$copy/index.html"

expect pass "the copy restored"
exit "$fails"
