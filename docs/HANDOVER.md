# Daily brief: hand-over

Where things stand on 26 Nov 2026, and how to pick the work up again later.

## What it is

A local Mac app that reads your Wispr Flow meetings and keeps one list of what you owe, what you're waiting on, and what was decided. A later meeting closes an item when it shows that the item is done. It is a Next.js server wrapped in a Tauri menu bar app (`Daily Brief.app`). Your data lives in `~/Daily Brief`.

## Where the code is

| What | Where |
| --- | --- |
| Repo | `maruthiram08/symmetrical-broccoli` |
| Local app (current) | branch `local`, PR #2 |
| Hosted version | on `local` behind `DAILY_BRIEF_MODE=hosted` (setup in `docs/HOSTED.md`); old `sprint-1` / PR #1 is superseded |
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
- **Check names:** `/people/review` to say a heard name is an existing person, a new one, or not a person; merge and split on person pages; "Speaker 5"-style labels hidden automatically.
- **Notes:** CodeMirror editor on day pages and `/notes`, slash commands (/todo, /owe, /waiting, /decision…), `[[person:]]` links with backlinks, writing assist (⌘J), and `/today` with the brief beside today's note.
- **More inputs and outputs** (all off until set up in Settings): Granola, Zoom, an inbox folder and phone calls; delivery by email, Slack, Telegram, WhatsApp; Send to Jira, Linear, Notion, Todoist; a local API (`docs/API.md`) and webhooks.
- **Workspaces and sync:** several notes folders, one-way folder sync (iCloud, Obsidian), git commit/push, editable templates, automatic `[[links]]` (on by default), and an Inbox for undated captures.
- **Other devices:** CLI (`daily-brief today`), phone web app with pairing (off by default), widget endpoint (`docs/WIDGET.md`), menu-bar count, Windows/Linux code paths and a release workflow (untested builds), and an optional local Ollama model.
- **Notes app parity (26 Nov evening):** open any Markdown folder with a file tree, note search, tabs and split, focus mode, fuller live preview, Mermaid, "last Tuesday" in ⌘K; properties, note types, `/tags`, `/views` (table, Kanban), projects; `/graph`, export to PDF, HTML and Word, password-protected share files, a theme creator; `/canvas`.
- **AI:** pick a provider per job in Settings › AI (Anthropic default; OpenAI, Gemini, OpenRouter, Groq, DeepSeek, Mistral, xAI, compatible, Ollama, or your own Claude plan, which is local-only and for personal use), Ask searches on the Mac and branches, `/setup/compare`, web clipper in `extensions/clipper/`.
- **Routines (`/routines`):** recurring tasks (daily, weekdays, chosen weekdays, monthly on day N with month-end clamping, every N days), ticked per day on Today, in the brief, notified at their time, with quick-add parsing ("every Monday …") and suggestions from meetings via the extraction's optional `recurrence` field. Date logic in `src/lib/routines/`, storage in the FileStore (`routines` in state.json), suggestion step in `src/server/jobs/routines.ts`. Not in the hosted store yet (`routineStore()` returns null there, and recurring promises stay ordinary items).
- **Hosted version:** Supabase sign-in, Postgres store with row-level security, Vercel crons, Resend email, teams and Razorpay billing (test mode only). Built and tested locally; never run against real accounts.

## Cross-check with Wispr Flow (26 Nov)

Off by default (Settings › AI). Code: `src/lib/crosscheck/` (parse the Flow Summary's next steps; compare and classify), `src/server/crosscheck/` (fetch, store, the batch run), `/crosscheck`, and a hook after commit in `src/server/jobs/process.ts` via `src/server/jobs/after-extract.ts` (never throws). Results live in `state.json` under `crosscheck`, one record per meeting. `WisprClient.getSummary` calls `get_meeting` without `view_transcript`.

Not verified: the real Flow Summary's shape (the parser was tested on hand-written summaries only) and the matching quality on real meetings with a real model. To try it: turn it on, open `/crosscheck`, press Cross-check all meetings, and compare a few rows with the meetings' notes in Wispr Flow. If next steps aren't found, add the summary's heading to `SECTION` in `src/lib/crosscheck/parse.ts`.

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

- **Hosted, channels, integrations:** need your own accounts and tokens; none were tried against the real services.
- **Windows/Linux:** dropped for now; the workflow exists but was never run.
- **Node:** the app now ships its own Node 22, so Homebrew Node is needed only to build.

- **Calendar:** Wispr Flow returns no calendar events for this account today, so calendar features stay hidden until a calendar is linked in Wispr Flow.
- **Speaker labels:** a promise can be credited to the wrong person when Wispr's speaker labels are wrong.
- **Decisions:** the least stable thing the extraction reads.
- **Unsigned app:** on another Mac, right-click and choose Open the first time. The installer disk is in `src-tauri/target/.../bundle/dmg/`.
- **Node:** the app carries its own Node 22 runtime (`scripts/node-runtime.mjs`, pinned and SHA-256 checked) and only falls back to a system Node (18.18+) when a build has none. Building still needs Node.

## If it scales later

The hosted path is built: follow `docs/HOSTED.md`, run `npm run hosted:check`, then `npm run hosted:migrate`. Local and hosted share the jobs through the `AppStore` interface.
