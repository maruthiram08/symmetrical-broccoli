#!/bin/zsh
# Builds Daily Brief.app (and a .dmg) for Apple Silicon:
#   1. next build with output: "standalone"
#   2. copies the standalone server, .next/static and public/ into build/app-server
#   3. tauri build --target aarch64-apple-darwin (bundles build/app-server as Resources/server)
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

echo "==> tauri build ($TARGET)"
npx tauri build --target "$TARGET" --bundles app,dmg || {
  echo "The .dmg step failed (it scripts Finder); building the .app only." >&2
  npx tauri build --target "$TARGET" --bundles app
}

BUNDLE="src-tauri/target/$TARGET/release/bundle"
APP="$BUNDLE/macos/Daily Brief.app"

echo
echo "App: $DIR/$APP"
for f in "$BUNDLE"/dmg/*.dmg(N); do echo "DMG: $DIR/$f"; done
echo
echo "Install:  rm -rf \"/Applications/Daily Brief.app\" && cp -R \"$DIR/$APP\" /Applications/"
echo "Secrets:  npm run keychain:import   (copies ANTHROPIC_API_KEY from .env.local into the Keychain)"
