# Daily brief (local)

Your meetings, turned into your day: what you owe, what you're waiting on, and what was decided. Everything runs on your Mac. Nothing is hosted, and your data stays in one folder.

## Run it

```bash
npm install
cp .env.example .env.local   # add your ANTHROPIC_API_KEY
npm run app                  # builds, then serves http://localhost:4242
```

Open http://localhost:4242. The first run is three short steps on one page: your name and brief time, connecting Wispr Flow, and how far back to read (7 days by default). It counts those meetings and shows the rough cost (about ₹3.50 a meeting) before reading anything.

Meetings others shared with you in Wispr Flow are left out unless you turn on **Include meetings others shared with me** in Settings. From a shared meeting, something counts as yours to do only when you speak in it; otherwise you see only what others promised you and decisions that name you, marked *shared*.

While the app is running it:
- checks Wispr Flow for new meetings every 30 minutes (or press **Check meetings now**),
- extracts what you owe, what you're waiting on and decisions, and closes items when a later meeting shows they're done,
- at your brief time, writes `~/Daily Brief/YYYY-MM-DD.md`, adds the day's decisions to `decisions.md`, and shows a Mac notification. If the Mac was asleep (or offline) at brief time, today's brief still goes out once after it wakes, after a fresh check of Wispr Flow.

When something needs you, every page says so with a button: Wispr Flow signed you out (**Reconnect Wispr Flow**), the Anthropic key was rejected or the account is out of credit, or a meeting couldn't be read after a few tries (**Retry**). Busy or overloaded API calls are retried with backoff by themselves. **Settings › Health** shows the last check, last meeting read, last brief, errors in the last 24 hours, the data file size and the app version.

## Your data

`~/Daily Brief/` (change with `DAILY_BRIEF_DIR`):
- `2026-11-25.md`, one plain Markdown note per day. Open it in any editor.
- `decisions.md`, every decision with its quote.
- `.daily-brief/state.json`, items and meetings (no transcripts, ever). Readable only by you.
- `.daily-brief/state.json.bak` and `state.json.bak-daily`, hourly and daily copies of it. If `state.json` is ever damaged, the app keeps it as `state.json.corrupt-<time>`, restores the newest good copy and tells you on every page.
- `.daily-brief/scheduler.lock`, so only one copy of the app (say, the Mac app and the launchd agent) checks meetings and sends the brief.
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

## Ask, nudges and changed decisions

These use your Anthropic key and the same model as extraction (`EXTRACTION_MODEL`). Only stored items go to Claude (text, person, quote, meeting title and date), never transcripts, and nothing is ever sent to anyone.

- **Ask** (`/ask`, or ⌘K then type a question and pick *Ask*): Claude answers from up to 40 matching items, found locally with search, and cites them as [1], [2], each linking to the item with its quote. When nothing matches it says "I don't see that in your meetings" without calling Claude. The page shows the estimated and actual cost; about ₹0.5-1.5 a question with the default model.
- **Nudges**: once a day, after the brief, each thing you're waiting on that is 3+ days overdue gets a short Slack-style nudge draft (Hinglish if the quote was), shown on the item with Copy and Start this. Drafted once per item and kept in `.daily-brief/ai.json`; at most 10 a day, about ₹0.2-0.5 each.
- **Changed decisions**: a new decision is compared with earlier ones on the same topic (word overlap, locally); only when one is similar does Claude get one small call to judge it. Today then shows "This may change the decision from 20 Nov: …" with *Keep both* or *Mark old as replaced*. About ₹0.2-0.5 per similar decision (at most 10 calls a run); decisions from before you turned this on are never checked.

A Claude skill for the MCP tools is in `skills/daily-brief/SKILL.md` (meeting prep, weekly review, and how to quote evidence).

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

The app keeps its secrets in the macOS Keychain (service `app.dailybrief`), not in files: the Anthropic API key, and the Wispr Flow token key, which moves there from `.daily-brief/key` on first start. `EXTRACTION_MODEL` and `WISPR_MCP_URL` go in `.daily-brief/settings.env` (`keychain:import` copies them). `npm start` still reads `.env.local` and falls back to the Keychain. The app always uses `~/Daily Brief`. The log is `~/Library/Logs/daily-brief.log`; the app rotates it at 5 MB and keeps three old copies (`.1` to `.3`). It never holds keys, tokens or transcript text.

**First launch.** The app isn't signed with an Apple Developer ID. A copy you built yourself opens normally. If macOS says it can't be opened (say, you copied it from another Mac): right-click (or Control-click) the app in Finder, choose **Open**, then **Open** again. Or allow it under System Settings › Privacy & Security › **Open Anyway**, or run `xattr -dr com.apple.quarantine "/Applications/Daily Brief.app"`.

## Keep it running at login without the app

`npm run install-login` sets up a launchd agent (`app.dailybrief`) that runs `npm start` at login. The Mac app replaces it: turn on **Launch at login** in the menu bar, and remove the agent with `npm run uninstall-login`. While the agent runs, the app reuses its server.

## Develop

`npm test`, `npm run typecheck`, `npm run lint`, `npm run eval` (extraction accuracy on real meetings; see `eval/README.md`).

The hosted version (Supabase, email, Vercel cron) lives on the `sprint-1` branch.
