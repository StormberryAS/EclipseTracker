#!/usr/bin/env bash
# Checks a built APK against android/expected-permissions.txt, byte for byte, in both directions
# (SunApp's rule: a vanished RECEIVE_BOOT_COMPLETED fails as loudly as an extra permission), and
# prints its SHA-256. A debug APK's package line carries the .debug suffix, which is allowed.
#
#   tools/check-apk.sh app/build/outputs/apk/release/app-release-unsigned.apk
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
apk="$1"
sdk="${ANDROID_HOME:-$(sed -n 's/^sdk.dir=//p' "$here/local.properties" 2>/dev/null)}"
aapt="$(ls -d "$sdk"/build-tools/*/aapt 2>/dev/null | sort -V | tail -1)"
[ -x "$aapt" ] || { echo "check-apk: no aapt under $sdk/build-tools" >&2; exit 2; }
got="$("$aapt" dump permissions "$apk" | sed 's/^package: no\.stormberry\.eclipsetracker\.debug$/package: no.stormberry.eclipsetracker/')"
if ! diff <(printf '%s\n' "$got") "$here/expected-permissions.txt"; then
  echo "check-apk: $apk does not ask for exactly the permissions in expected-permissions.txt" >&2
  exit 1
fi
echo "check-apk: permissions exactly as expected-permissions.txt ($(grep -c '^uses-permission' "$here/expected-permissions.txt"))"
sha256sum "$apk"
