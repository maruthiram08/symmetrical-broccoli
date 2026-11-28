#!/bin/zsh
# Builds Daily Brief.app (and a .dmg) for Apple Silicon:
#   1. next build with output: "standalone"
#   2. copies the standalone server, .next/static and public/ into build/app-server
#   3. downloads the pinned Node runtime (SHA-256 checked, cached in src-tauri/target/node-cache)
#      into build/node-runtime (scripts/node-runtime.mjs)
#   4. tauri build --target aarch64-apple-darwin --bundles app (bundles build/app-server as
#      Resources/server and build/node-runtime as Resources/node-runtime)
#   5. scripts/make-dmg.sh: the .dmg with hdiutil, retried. A failed .dmg never fails the build.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
TARGET=aarch64-apple-darwin

if [[ "$(uname)" != Darwin ]]; then
  echo "mac:build runs on macOS only." >&2; exit 1
fi
if ! command -v cargo >/dev/null; then
  echo "Rust is missing. Install it, then run this again:" >&2
  echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && source \"\$HOME/.cargo/env\"" >&2
  exit 1
fi
if [[ -L node_modules ]]; then
  # Next would put a symlink to it in .next/standalone, and the next `next build` deletes through it.
  echo "node_modules is a symlink. Run npm install in this folder first." >&2; exit 1
fi
if command -v rustup >/dev/null; then rustup target add "$TARGET" >/dev/null; fi

echo "==> next build (standalone)"
rm -rf .next/standalone
NEXT_OUTPUT_STANDALONE=1 npx next build

echo "==> staging the server in build/app-server"
STAGE=build/app-server
rm -rf "$STAGE" && mkdir -p "$STAGE"
cp -R .next/standalone/. "$STAGE/"
mkdir -p "$STAGE/.next" && cp -R .next/static "$STAGE/.next/static"
[[ -d public ]] && cp -R public "$STAGE/public"
# Never ship local env files: the app reads secrets from the Keychain.
find "$STAGE" -maxdepth 1 -name '.env*' -exec rm -f {} +
[[ -f "$STAGE/server.js" ]] || { echo "No server.js in the standalone build." >&2; exit 1; }

echo "==> bundled Node runtime"
# Picks up HTTPS_PROXY if you have one set (Node 22.21+).
NODE_USE_ENV_PROXY=1 node scripts/node-runtime.mjs --target "$TARGET"
[[ -x build/node-runtime/node ]] || { echo "No node in build/node-runtime." >&2; exit 1; }

echo "==> tauri build ($TARGET, .app)"
# The .dmg is made below with plain hdiutil: tauri's bundle_dmg fails with "Resource busy" too often.
npx tauri build --target "$TARGET" --bundles app

BUNDLE="src-tauri/target/$TARGET/release/bundle"
APP="$BUNDLE/macos/Daily Brief.app"
[[ -d "$APP" ]] || { echo "No app at $APP." >&2; exit 1; }
VERSION=$(node -p 'require("./src-tauri/tauri.conf.json").version')
DMG="$BUNDLE/dmg/Daily Brief_${VERSION}_aarch64.dmg"

echo "==> dmg"
if ! bash scripts/make-dmg.sh "$APP" "$DMG"; then
  echo "The .dmg step failed; the .app is fine and is all you need." >&2
  DMG=
fi

echo
echo "App: $DIR/$APP ($(du -sh "$APP" | cut -f1))"
[[ -n "$DMG" && -f "$DMG" ]] && echo "DMG: $DIR/$DMG ($(du -sh "$DMG" | cut -f1))"
echo
echo "Install:  rm -rf \"/Applications/Daily Brief.app\" && cp -R \"$DIR/$APP\" /Applications/"
echo "Secrets:  npm run keychain:import   (copies ANTHROPIC_API_KEY from .env.local into the Keychain)"
