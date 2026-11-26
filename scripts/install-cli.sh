#!/bin/sh
# npm run cli:install : puts the daily-brief command on your PATH with a symlink to bin/daily-brief.
# Uses /opt/homebrew/bin when you can write to it (Homebrew on Apple silicon), else ~/.local/bin.
# Never runs sudo: if neither works it prints the command to run yourself.
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$DIR/bin/daily-brief"
chmod +x "$SRC"

pick() {
  for d in "${DAILY_BRIEF_BIN_DIR:-}" /opt/homebrew/bin "$HOME/.local/bin"; do
    [ -n "$d" ] || continue
    if [ -d "$d" ] && [ -w "$d" ]; then echo "$d"; return; fi
    if [ "$d" = "$HOME/.local/bin" ] && mkdir -p "$d" 2>/dev/null; then echo "$d"; return; fi
  done
}

TARGET_DIR="$(pick)"
if [ -z "$TARGET_DIR" ]; then
  echo "No folder on your PATH is writable. Run this yourself:"
  echo "  sudo ln -sf \"$SRC\" /usr/local/bin/daily-brief"
  exit 1
fi
DEST="$TARGET_DIR/daily-brief"
if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
  echo "$DEST exists and isn't a link; leaving it. Remove it and run this again."
  exit 1
fi
echo "ln -sf \"$SRC\" \"$DEST\""
ln -sf "$SRC" "$DEST"
case ":$PATH:" in
  *":$TARGET_DIR:"*) ;;
  *) echo "Add $TARGET_DIR to your PATH, e.g. in ~/.zshrc:"; echo "  export PATH=\"$TARGET_DIR:\$PATH\"" ;;
esac
echo "Done. Try: daily-brief today"
