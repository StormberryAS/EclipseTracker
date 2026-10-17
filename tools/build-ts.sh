#!/usr/bin/env bash
# Compile the app's TypeScript (ts/) into the JavaScript the page loads.
#
# Copied on 16 October 2026 from the Website's tools/build-ts.sh (the TypeScript move of
# 2026-10-14) and changed in one way: EclipseTracker's code is ES modules (app.js imports core/*.js),
# and bump_assets.py stamps every relative import with the imported file's hash (?v=...), as it does
# in GDPRLetterBuilder and CheckLink. A compiled .js at the root therefore differs from what tsc
# writes in exactly those stamps, so every comparison below strips them first ("normalised"), and
# bump_assets.py --check then proves the stamps themselves are current.
#
#   tools/build-ts.sh           install the pinned compiler, compile every ts/**/*.ts (types.ts
#                               included: it compiles to an empty module) into the .js of the same
#                               path at the repository root (ts/app.ts -> app.js, ts/core/x.ts ->
#                               core/x.js), then run bump_assets.py so every import and every page
#                               carries the current ?v= stamp
#   tools/build-ts.sh --force   the same, but overwrite a compiled .js even when it holds a hand edit
#   tools/build-ts.sh --check   change nothing: fail when a compiled .js is missing, is not tracked
#                               by git, or is not (stamps aside) byte for byte what ts/ compiles to;
#                               when app.js's folder or core/ holds a .js that no ts/ source
#                               compiles to (a stray left behind by a renamed or deleted source,
#                               which the site would still publish; code review C-16, 2026-10-16);
#                               when a page or an import carries a stale ?v=; or when the eclipse
#                               list (ts/core/data.ts, data/eclipses.json) is not what the archived
#                               NASA pages in tools/nasa/ give
#
# Every mode first type-checks ts/core/ on its own with tsconfig.core.json, whose only library is
# ES2020: no DOM. core/ is what stage B's Kotlin port copies and what Node tests run, so a browser
# object used there (document, window, TextEncoder) is an error, not a habit (code review C-17).
#
# The compiled .js files are committed on purpose: GitHub Pages publishes the repository's files as
# they are, with no build step of its own. Edit ts/*.ts, never the .js.
#
# Hand edits. A build never overwrites a compiled .js silently. It writes only when the .js now at
# the root, normalised, is one some ts/ source produced: what the committed ts/ (HEAD) compiles to,
# what the current ts/ compiles to, or what this script wrote last time (its record lives in the git
# directory, so it is never committed or published). Anything else is an edit made in the .js
# itself: the build stops and writes nothing. Port the edit into ts/ and build again, or rerun with
# --force to drop it.
#
# The compiler is the exact version in package-lock.json, installed with `npm ci` (a frozen install)
# and with install scripts off. Needs Node and npm (Node 24 on the Dell), python3, and git for the
# hand-edit guard and the tracked-file check (both are skipped outside a git checkout).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

case "$#:${1:-}" in
  0:)        MODE=build ;;
  1:--force) MODE=force ;;
  1:--check) MODE=check ;;
  *)         echo "usage: $0 [--check | --force]" >&2; exit 2 ;;
esac

die() { echo "build-ts: $*" >&2; exit 1; }
command -v node >/dev/null || die "node not found"
command -v npm >/dev/null || die "npm not found"
command -v python3 >/dev/null || die "python3 not found"
GIT=0
if command -v git >/dev/null && [ "$(git rev-parse --show-toplevel 2>/dev/null)" = "$ROOT" ]; then GIT=1; fi

npm ci --ignore-scripts --no-audit --no-fund --prefer-offline --loglevel=error >/dev/null \
  || die "npm ci failed (package.json and package-lock.json must agree; nothing was compiled)"
TSC=(node "$ROOT/node_modules/typescript/bin/tsc")
echo "build-ts: TypeScript $("${TSC[@]}" --version | sed 's/^Version //')"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# A relative import with its ?v= stamp removed: from './core/x.js?v=0123abcd' to from './core/x.js'.
normalise() { sed -E "s#(['\"]\\.{1,2}/[^'\"?]+\\.js)\\?v=[0-9a-f]{8}(['\"])#\\1\\2#g" "$1"; }
nsha() { normalise "$1" | sha256sum | cut -d' ' -f1; }

"${TSC[@]}" -p "$ROOT/tsconfig.core.json" \
  || die "ts/core/ uses something only a browser has (see above): core/ stays free of the DOM; nothing was written"
"${TSC[@]}" -p "$ROOT/tsconfig.json" --outDir "$tmp/out" || die "ts/ does not compile; nothing was written"

mapfile -t OUTPUTS < <(cd "$tmp/out" && find . -type f -printf '%P\n' | LC_ALL=C sort)
mapfile -t EXPECTED < <(cd ts && find . -type f -name '*.ts' ! -name '*.d.ts' -printf '%P\n' | sed 's/\.ts$/.js/' | LC_ALL=C sort)
[ "${#OUTPUTS[@]}" -gt 0 ] || die "tsc emitted nothing"
[ "${OUTPUTS[*]}" = "${EXPECTED[*]}" ] \
  || die "tsc emitted [${OUTPUTS[*]}] but ts/ holds sources for [${EXPECTED[*]}]; look at tsconfig.json"

tracked() { [ "$GIT" = 1 ] && git ls-files --error-unmatch -- "$1" >/dev/null 2>&1; }

if [ "$MODE" = check ]; then
  bad=0
  [ "$GIT" = 1 ] || echo "build-ts: not a git checkout; skipping the tracked-file check"
  for f in "${OUTPUTS[@]}"; do
    if [ ! -f "$f" ]; then
      echo "build-ts: $f is missing: run tools/build-ts.sh" >&2; bad=1
    elif [ "$(nsha "$f")" != "$(nsha "$tmp/out/$f")" ]; then
      echo "build-ts: $f is NOT what ts/ compiles to: edit ts/, then run tools/build-ts.sh" >&2; bad=1
    elif [ "$GIT" = 1 ] && ! tracked "$f"; then
      echo "build-ts: $f is what ts/ compiles to but is not tracked by git: git add it" >&2; bad=1
    else
      echo "build-ts: $f matches ts/"
    fi
  done
  # Compiled JavaScript with no source: app.js's folder and core/ hold only what ts/ compiles to.
  mapfile -t PRESENT < <({ find . -maxdepth 1 -type f -name '*.js' -printf '%P\n'; [ -d core ] && find core -type f -name '*.js'; } | LC_ALL=C sort)
  for f in "${PRESENT[@]}"; do
    case " ${OUTPUTS[*]} " in
      *" $f "*) ;;
      *) echo "build-ts: $f is compiled JavaScript that no ts/ source compiles to: delete it (git rm), or restore its source" >&2; bad=1 ;;
    esac
  done
  python3 -I "$ROOT/tools/build-eclipse-data.py" --check || bad=1
  python3 -I "$ROOT/bump_assets.py" --check || bad=1
  [ "$bad" = 0 ] || exit 1
  echo "build-ts: check passed"
  exit 0
fi

STATE=""
[ "$GIT" = 1 ] && STATE="$(git rev-parse --absolute-git-dir)/build-ts.last"

if [ "$MODE" = build ]; then
  if [ "$GIT" = 1 ] && git cat-file -e HEAD:tsconfig.json 2>/dev/null && git cat-file -e HEAD:ts 2>/dev/null; then
    mkdir -p "$tmp/head"
    git archive HEAD tsconfig.json ts | tar -x -C "$tmp/head"
    "${TSC[@]}" -p "$tmp/head/tsconfig.json" --outDir "$tmp/head-out" >/dev/null 2>&1 || true
  fi
  hand=()
  for f in "${OUTPUTS[@]}"; do
    [ -f "$f" ] || continue
    cur="$(nsha "$f")"
    [ "$cur" = "$(nsha "$tmp/out/$f")" ] && continue
    [ -f "$tmp/head-out/$f" ] && [ "$cur" = "$(nsha "$tmp/head-out/$f")" ] && continue
    [ -n "$STATE" ] && [ -f "$STATE" ] && grep -qxF "$cur  $f" "$STATE" && continue
    hand+=("$f")
  done
  if [ "${#hand[@]}" -gt 0 ]; then
    for f in "${hand[@]}"; do
      echo "build-ts: $f holds changes that no ts/ source produced (edited by hand?)" >&2
    done
    die "nothing was written. Port the change into ts/ (git diff and git log -p show it), then build again; or run tools/build-ts.sh --force to overwrite it."
  fi
fi

wrote=0
for f in "${OUTPUTS[@]}"; do
  if [ -f "$f" ] && [ "$(nsha "$f")" = "$(nsha "$tmp/out/$f")" ]; then continue; fi
  mkdir -p "$(dirname "$f")"
  cp "$tmp/out/$f" "$f"
  echo "build-ts: wrote $f"
  wrote=1
  if [ "$GIT" = 1 ] && ! tracked "$f"; then
    echo "build-ts: $f is new: git add it" >&2
  fi
done
[ "$wrote" = 1 ] || echo "build-ts: compiled output unchanged"
if [ -n "$STATE" ]; then
  for f in "${OUTPUTS[@]}"; do printf '%s  %s\n' "$(nsha "$f")" "$f"; done > "$STATE"
fi

# Always: bump_assets.py changes nothing when every stamp is current, and repairs a stale one even
# when the compiled output did not change.
python3 -I "$ROOT/bump_assets.py"
