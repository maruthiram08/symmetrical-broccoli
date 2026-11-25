# Daily brief (local)

Your meetings, turned into your day: what you owe, what you're waiting on, and what was decided. Everything runs on your Mac. Nothing is hosted, and your data stays in one folder.

## Run it

```bash
npm install
cp .env.example .env.local   # add your ANTHROPIC_API_KEY
npm run app                  # builds, then serves http://localhost:4242
```

Open http://localhost:4242, fill in your name and brief time, and connect Wispr Flow. The app reads your last 7 days straight away.

While the app is running it:
- checks Wispr Flow for new meetings every 30 minutes (or press **Check meetings now**),
- extracts what you owe, what you're waiting on and decisions, and closes items when a later meeting shows they're done,
- at your brief time, writes `~/Daily Brief/YYYY-MM-DD.md`, adds the day's decisions to `decisions.md`, and shows a Mac notification. If the Mac was asleep, it catches up within an hour of waking.

## Your data

`~/Daily Brief/` (change with `DAILY_BRIEF_DIR`):
- `2026-11-25.md`, one plain Markdown note per day. Open it in any editor.
- `decisions.md`, every decision with its quote.
- `.daily-brief/state.json`, items and meetings (no transcripts, ever). Readable only by you.
- `.daily-brief/key`, a local key for the Wispr Flow sign-in step.

To start over, quit the app and delete `.daily-brief/`.

## Keep it running at login (optional)

Save as `~/Library/LaunchAgents/app.dailybrief.plist`, fix the path, then `launchctl load ~/Library/LaunchAgents/app.dailybrief.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.dailybrief</string>
  <key>WorkingDirectory</key><string>/Users/YOU/code/daily-brief</string>
  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>-lc</string><string>npm start</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
```

## Develop

`npm test`, `npm run typecheck`, `npm run lint`, `npm run eval` (extraction accuracy on real meetings; see `eval/README.md`).

The hosted version (Supabase, email, Vercel cron) lives on the `sprint-1` branch.
