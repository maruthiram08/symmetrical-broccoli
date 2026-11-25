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

## Ask Claude about your brief

A local MCP server lets Claude Desktop or Claude Code read your brief and close items: "what do I owe Tarun?", "what did we decide about the dividend banner?", "mark the venue booking done".

```bash
npm run mcp:install   # prints the config to copy; it changes nothing
```

It prints a `daily-brief` entry for Claude Desktop's `claude_desktop_config.json` (Claude > Settings > Developer > Edit Config) and the line for Claude Code:

```bash
claude mcp add daily-brief -- npm --prefix /path/to/daily-brief run -s mcp
```

Tools: `today` (the Today screen), `list_open` (by kind and person), `person` (everything with one person, fuzzy name), `search`, `decisions` (by topic and date), and `mark_item` (done / wrong / reopen, the same change as the buttons). Answers carry the item id, person, due date, meeting and the exact quote.

It reads the same `state.json` as the app (`DAILY_BRIEF_DIR` works here too), re-reading it on every call, and the app picks up `mark_item` changes on its next read. It never calls the Anthropic API or Wispr Flow, and the app doesn't need to be running.

## The Mac app

`Daily Brief.app` is a small Tauri window and menu bar item around the same server. It starts the server with your Node.js (Homebrew's is fine, 18.18 or later), or reuses one already running on port 4242, and stops the one it started when you quit. Closing the window keeps it in the menu bar, where you also find **Check meetings now**, **Open in browser** and **Launch at login**.

Build it (Apple Silicon; needs Xcode Command Line Tools and Rust):

```bash
xcode-select --install                     # if you don't have them yet
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && source "$HOME/.cargo/env"
npm install
npm run mac:build                          # prints the .app and .dmg paths
npm run keychain:import                    # moves ANTHROPIC_API_KEY from .env.local into the Keychain
npm run uninstall-login                    # if you used npm run install-login before
cp -R "src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Daily Brief.app" /Applications/
```

The app keeps its secrets in the macOS Keychain (service `app.dailybrief`), not in files: the Anthropic API key, and the Wispr Flow token key, which moves there from `.daily-brief/key` on first start. `EXTRACTION_MODEL` and `WISPR_MCP_URL` go in `.daily-brief/settings.env` (`keychain:import` copies them). `npm start` still reads `.env.local` and falls back to the Keychain. The app always uses `~/Daily Brief`. The log is `~/Library/Logs/daily-brief.log`.

**First launch.** The app isn't signed with an Apple Developer ID. A copy you built yourself opens normally. If macOS says it can't be opened (say, you copied it from another Mac): right-click (or Control-click) the app in Finder, choose **Open**, then **Open** again. Or allow it under System Settings › Privacy & Security › **Open Anyway**, or run `xattr -dr com.apple.quarantine "/Applications/Daily Brief.app"`.

## Keep it running at login without the app

`npm run install-login` sets up a launchd agent (`app.dailybrief`) that runs `npm start` at login. The Mac app replaces it: turn on **Launch at login** in the menu bar, and remove the agent with `npm run uninstall-login`. While the agent runs, the app reuses its server.

## Develop

`npm test`, `npm run typecheck`, `npm run lint`, `npm run eval` (extraction accuracy on real meetings; see `eval/README.md`).

The hosted version (Supabase, email, Vercel cron) lives on the `sprint-1` branch.
