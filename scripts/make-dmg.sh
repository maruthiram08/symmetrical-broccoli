#!/bin/bash
# Makes a drag-to-install .dmg from a built .app with plain hdiutil, retrying the
# "hdiutil: create failed - Resource busy" that tauri's bundle_dmg hits on most builds.
# Used by scripts/mac-build.sh and .github/workflows/desktop.yml.
#   scripts/make-dmg.sh "path/to/Daily Brief.app" "path/to/Daily Brief_0.1.0_aarch64.dmg"
# Exits non-zero only when every attempt failed; the .app is never touched.
set -uo pipefail

APP=${1:?usage: make-dmg.sh <app> <dmg>}
DMG=${2:?usage: make-dmg.sh <app> <dmg>}
VOL="Daily Brief"
ATTEMPTS=${DMG_ATTEMPTS:-5}

if [[ ! -d "$APP" ]]; then
  echo "No app at $APP" >&2
  exit 1
fi

# A volume left mounted by an earlier (failed) build keeps the image busy.
detach_stale() {
  local v
  for v in "/Volumes/$VOL"*; do
    [[ -d "$v" ]] || continue
    echo "    detaching stale $v"
    hdiutil detach "$v" -quiet 2>/dev/null || hdiutil detach "$v" -force -quiet 2>/dev/null || true
  done
}

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/daily-brief-dmg.XXXXXX") || exit 1
trap 'rm -rf "$STAGE"' EXIT
# ditto keeps the bundle's signature, symlinks and permissions intact.
ditto "$APP" "$STAGE/$(basename "$APP")" || exit 1
ln -s /Applications "$STAGE/Applications"
mkdir -p "$(dirname "$DMG")"

attempt=1
while true; do
  detach_stale
  rm -f "$DMG"
  echo "==> hdiutil create (attempt $attempt of $ATTEMPTS)"
  if hdiutil create -volname "$VOL" -srcfolder "$STAGE" -ov -format UDZO "$DMG"; then
    echo "DMG: $DMG"
    exit 0
  fi
  if ((attempt >= ATTEMPTS)); then
    rm -f "$DMG"
    echo "hdiutil create failed $ATTEMPTS times; no .dmg this time." >&2
    exit 1
  fi
  sleep $((attempt * 3))
  attempt=$((attempt + 1))
done
