#!/bin/zsh
# Start Daily brief at login and keep it running. Undo: launchctl bootout gui/$(id -u)/app.dailybrief
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/app.dailybrief.plist"
LOG="$HOME/Library/Logs/daily-brief.log"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.dailybrief</string>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>-lc</string><string>npm start</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PL
# Stop a hand-started copy so the port is free.
lsof -ti tcp:4242 -sTCP:LISTEN | xargs kill 2>/dev/null || true
sleep 1
launchctl bootout "gui/$(id -u)/app.dailybrief" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 4
curl -s -o /dev/null -w "Daily brief: HTTP %{http_code} at http://localhost:4242\n" http://localhost:4242/setup
echo "It now starts at login. To turn that off: launchctl bootout gui/\$(id -u)/app.dailybrief"
