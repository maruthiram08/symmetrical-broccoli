#!/bin/zsh
# Removes the old launchd agent (label app.dailybrief) that `npm run install-login` set up.
# The Mac app replaces it: turn on "Launch at login" in its menu bar menu instead.
LABEL="app.dailybrief"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
echo "+ launchctl bootout gui/$(id -u)/$LABEL"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "Stopped $LABEL." || echo "$LABEL wasn't running."
if [[ -f "$PLIST" ]]; then
  rm -f "$PLIST"
  echo "Removed $PLIST."
fi
echo "Daily brief no longer starts from launchd. Use the app's \"Launch at login\" instead."
