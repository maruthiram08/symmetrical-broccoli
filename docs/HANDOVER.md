# Daily brief: hand-over

Where things stand on 26 Nov 2026, and how to pick the work up again later.

## What it is

A local Mac app that reads your Wispr Flow meetings and keeps one list of what you owe, what you're waiting on, and what was decided. A later meeting closes an item when it shows that the item is done. It is a Next.js server wrapped in a Tauri menu bar app (`Daily Brief.app`). Your data lives in `~/Daily Brief`.

## Where the code is

| What | Where |
| --- | --- |
| Repo | `maruthiram08/symmetrical-broccoli` |
| Local app (current) | branch `local`, PR #2 |
| Hosted version (parked) | branch `sprint-1`, PR #1 (draft): Supabase, Resend email, Vercel cron |
| Checkout on the Mac | `~/Desktop/DE/meetingtranscripts/daily-brief` |
| Data | `~/Daily Brief/.daily-brief/state.json` (+ `.bak` hourly, `.bak-daily`), daily notes `~/Daily Brief/YYYY-MM-DD.md`, `decisions.md` |
| Secrets | Keychain service `app.dailybrief` (Anthropic key, token key). Non-secret settings in `.daily-brief/settings.env` |
| Logs | `~/Library/Logs/daily-brief.log` (rotated at 5 MB) |

## Update the app on the Mac

```bash
cd ~/Desktop/DE/meetingtranscripts/daily-brief
git fetch origin local && git reset --hard origin/local
npm install
npm run mac:build
cp -R "src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Daily Brief.app" /Applications/
# then quit Daily Brief from the menu bar and open it again
```

`npm run dev` still runs the server alone on http://localhost:4242 for development.

## What's built

See the "Where we are" table in the roadmap doc. In short:

- **Reading meetings:** read meetings since any date, auto-close, Hinglish and hedged promises (eval: `npm run eval`, results in `eval/RESULTS.md`), and an optional switch for meetings others shared with you.
- **Today:** wrap, This week, the close moment, quote peek, day ribbon, prep card, "who's waiting on you", quiet streak.
- **People, search and Ask:** People and person hover, search and Cmd+K, Ask with cited items.
- **Items:** promise timeline and related items on each item's page, Start this hand-offs, nudge drafts, changed-decision cards.
- **Your own entries:** quick capture (`c`, Cmd+K, tray), your own items, star and snooze, notes on daily pages.
- **Calendar:** tomorrow at a glance, recurring-meeting pages, due hints, Block 30 min (.ics).
- **Claude:** an MCP server (`npm run mcp`, connected in Claude Code and Claude Desktop) and a skill at `skills/daily-brief/SKILL.md`.
- **Reliability:** reconnect and API-key banners, retries, catching up after sleep, backups with auto-restore, a single-writer lock, and a Health section in Settings.

## Costs

The API key is yours (claude-sonnet-5-5).

| Action | Cost |
| --- | --- |
| Reading a meeting | about ₹3.5 |
| Ask | about ₹0.5 to ₹1.5 per question |
| Nudges | at most 10 a day, about ₹5 a day at worst |
| Changed-decision checks | a few rupees a week |
| Re-read all meetings (Settings) | about ₹3.5 × every meeting; keeps your Done/Wrong marks |

## Known gaps

- **Calendar:** Wispr Flow returns no calendar events for this account today, so calendar features stay hidden until a calendar is linked in Wispr Flow.
- **Speaker labels:** a promise can be credited to the wrong person when Wispr's speaker labels are wrong.
- **Decisions:** the least stable thing the extraction reads.
- **Unsigned app:** on another Mac, right-click and choose Open the first time. The installer disk is in `src-tauri/target/.../bundle/dmg/`.
- **Node dependency:** the app needs Homebrew Node (18.18 or later).

## If it scales later

The hosted path (email or Slack delivery, sign-in, cloud database, WhatsApp, other recorders, mobile) is planned in the roadmap doc and started on `sprint-1`. The jobs (`src/server/jobs/*`) work through a `Store` interface, so a cloud store can replace the file store.
