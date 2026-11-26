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

## Add your own, star and snooze

- Press **c** anywhere (or ⌘K › Add…, or **Quick add…** in the menu bar) and type one line: "send Nitin the deck by Fri", "Tarun owes me API spec tomorrow". It's read on your Mac, no AI: kind, person and due date (today, tomorrow, a weekday or a date), which you can change before saving. Items you add show "added by you" and can be edited or deleted.
- On any list: **j**/**k** move, **s** star (pins it to the top), **z** snooze until a day, **d** done, **w** wrong, **e** edit your own, **F** follow up (Start this).
- On an earlier day's page, **Your notes** saves into that day's `.md` between `<!-- daily-brief:your-notes -->` markers, and stays when the brief is written again (see Notes below).

## Notes

Daily notes (**Your notes** on a day, and **Today's note** in the Today view) and free-form pages under **Notes** use one editor. It edits the Markdown itself with a live preview: markup hides except on the line you're on, so files stay byte-for-byte what you typed (line endings included) and open cleanly in any other app. Pages are `~/Daily Brief/notes/<name>.md`, newest first on `/notes`.

- **Saving.** As you type, on blur, on leaving the page and on ⌘S. Until a save lands the text is also kept in the browser, so a closed window or a stopped server doesn't lose it; it saves when the app is reachable again. If a page changed in another app while it was open, that version is kept as `notes/<name>.conflict-<time>.md`.
- **Slash commands.** Type `/`: **/todo**, **/owe**, **/waiting** (type the line, press Enter: it is read by the same parser as quick capture and becomes one of your items, written back as a linked checkbox), **/decision** (a decision callout), **/date** (today, or `/date fri`), **/person**, **/link**, **/heading**, **/quote**, **/callout**, **/divider**, **/table**, **/toggle**, **/checklist**.
- **Links.** Type `[[` (or ⌘K) to link a person, note, meeting or item, or make a new note. Links are written `[[person:Nitin K]]`, `[[note:q4-plan|Q4 plan]]`, `[[item:<id>|Send the deck]]`, `[[day:2026-11-26]]`; click one to open it. People, notes and days show **Linked from** with the lines that link there. Ticking an item's checkbox in a note marks the item done.
- **Rich blocks** are plain Markdown underneath: callouts `> [!note] Title`, toggles `<details><summary>…</summary>`, GFM tables and `- [ ]` checklists.
- **Keys.** ⌘B bold, ⌘I italic, ⌘E code, ⇧⌘X strike, ⌘Enter checkbox, Tab/⇧Tab indent.
- **Writing assist.** Select text for **Tidy**, **Shorter**, **Slack message** or **Hinglish → English** (⌘J, then 1-4). Only the selected text goes to Claude, with your key and model (`EXTRACTION_MODEL`); the estimate shows before and the cost after, usually well under ₹0.5. **Replace**, **Insert below** or **Copy**. Off without `ANTHROPIC_API_KEY`, and paused while the key or credit banner is showing.

**Today view** (`/today`, or *With today's note* on Today) puts the brief and today's note side by side on a wide window.

## Properties, types, tags, views and projects

- **Properties.** A note's YAML front matter shows as a panel above the editor: text, number, date, checkbox, list, or a link to a person or note (`[[person:Nitin]]`). Editing one property rewrites only its lines; the rest of the front matter stays exactly as written. Values the panel can't edit simply (nested YAML) are shown read-only.
- **Note types.** Meeting note, Project and Person note come with default properties and a template. Change them or add your own on **Notes → Note types** (`/note-types`); they live in `.daily-brief/note-types.json` per workspace. Make one from the slash menu (`/new project Q4 launch`, then Enter: the line becomes a link to the new note) or from ⌘K.
- **Tags.** Write `#tag` or `#nested/tag` in a note, put `tags:` in its properties, or add `#tag` in quick capture; items can carry tags from their page. `/tags` shows the tree with counts; a tag's page lists its notes and items. ⌘-click a tag in the editor to open it. Tags are in ⌘K.
- **Views.** Saved views over notes (by type, property or tag) or items (by status, kind, person, project or tag), with filter, sort and group, as a **Table** (click a header to sort; safe cells edit in place) or **Kanban** (drag a card, or use its Move menu, to change status or a property). They're listed on `/views`, each gets a sidebar entry, and they're kept per workspace (also in the hosted version).
- **Projects.** A project is a note of type Project. Assign an item from its page, the "…" menu on a brief line, or quick capture (`+december-launch`: a project that doesn't exist yet is made). The project's note shows a board (You owe, Waiting on, Done) and its linked notes. **Group by project** on Today groups the brief by project.

## Your data

`~/Daily Brief/` (change with `DAILY_BRIEF_DIR`):
- `2026-11-25.md`, one plain Markdown note per day. Open it in any editor.
- `decisions.md`, every decision with its quote.
- `.daily-brief/state.json`, items and meetings (no transcripts, ever). Readable only by you.
- `.daily-brief/state.json.bak` and `state.json.bak-daily`, hourly and daily copies of it. If `state.json` is ever damaged, the app keeps it as `state.json.corrupt-<time>`, restores the newest good copy and tells you on every page.
- `.daily-brief/scheduler.lock`, so only one copy of the app (say, the Mac app and the launchd agent) checks meetings and sends the brief.
- `.daily-brief/key`, a local key for the Wispr Flow sign-in step.
- `.daily-brief/phone.json`, Phone access: on or off, paired phones and widget tokens (hashes only).
- `.daily-brief/prefs.json`, which model reads meetings (Claude or a local Ollama model).

To start over, quit the app and delete `.daily-brief/`.

## On your phone

Daily brief works as an app on your phone (a PWA): Today, All open and People, with the same
buttons. It is off by default; the app only answers on this computer (127.0.0.1).

**Turn it on:** Settings › **Phone access**. The app then also listens on your Mac's Wi-Fi address,
on port 4243 (say `http://192.168.1.20:4243`), and shows a 6-digit pairing code. On the phone, open
that address, enter the code, then:

- **iPhone:** Safari › Share › **Add to Home Screen**.
- **Android:** Chrome › ⋮ › **Add to Home screen** (or **Install app**).

How it is kept safe:

- The app itself still listens on 127.0.0.1 only. A separate small server on the LAN address checks
  every request before passing it on, refuses requests for any other host name, and is not started
  at all while Phone access is off.
- A pairing code is good for one phone, for 10 minutes and 5 tries. Each phone gets its own random
  key in an HttpOnly cookie; only its hash is stored (`.daily-brief/phone.json`). **Remove** a phone
  in Settings to sign it out, or **Sign out all phones**.
- Phone access, widget tokens and the reading model can only be changed on the Mac, never from a phone.
- Plain Wi-Fi means plain HTTP: someone else on the same network could read the pages you load. Turn
  it on at home or on networks you trust. For HTTPS, point the app at a certificate in
  `.daily-brief/settings.env`:

  ```bash
  PHONE_TLS_CERT=/path/to/cert.pem
  PHONE_TLS_KEY=/path/to/key.pem
  PHONE_HOSTNAME=my-mac.tailnet-name.ts.net   # the name in the certificate
  ```

  The easy way is [Tailscale](https://tailscale.com): `tailscale cert my-mac.tailnet-name.ts.net`
  makes a real certificate, and your phone reaches the Mac from anywhere on your tailnet. `PHONE_BIND`
  (an address) and `PHONE_PORT` change where it listens. Restart the app after changing these.

**Offline:** once it is served over HTTPS (or on the Mac at `localhost`), a service worker keeps
Today, All open and People (and any person or item you opened) on the device, so they open
read-only without a connection, with an *Offline* pill. Pages it never saved show a short offline
page. Phones only allow this over HTTPS, so over plain Wi-Fi the phone needs the Mac awake and nearby.

**Widget:** an iOS Shortcut or widget can show *3 you owe today · 1 overdue* from `/api/widget`
with a widget token from Settings › **Phone widget**. Recipe: [`docs/WIDGET.md`](docs/WIDGET.md). The
Mac's menu bar item shows the same count as its title.

## Reading meetings on this computer (Ollama)

Settings › **Reading model** › **Local (Ollama)** reads meetings with a model on this computer
instead of Claude: transcripts never leave it and reading costs nothing. It uses the same prompt and
output schema (Ollama's JSON mode), and the same check that every quote is really in the transcript.

```bash
brew install ollama        # or see ollama.com for Windows and Linux
ollama serve &
ollama pull qwen2.5:14b    # or llama3.1:8b on a smaller machine
```

Then pick Local, set the model, and press **Save and test Ollama**. Expect lower quality: local
models miss more promises, close fewer items and handle Hinglish worse. If Ollama isn't running, a
meeting waits and is tried again later. Claude stays the default; Ask, nudges and changed-decision
checks keep using Claude when a key is set.

## Workspaces, templates, links and sync

- **Workspaces** (Settings › Workspace, or `/workspaces`): each workspace is a notes folder with its own items, daily notes, `.daily-brief/` data and Wispr Flow connection. The first one is always `~/Daily Brief` (or `DAILY_BRIEF_DIR`); the list lives in its `.daily-brief/workspaces.json`, and the one you pick is remembered. Switch from the sidebar once there are two. Background checks and briefs run for every workspace. Removing a workspace only takes it off the list; its folder is left alone. The Anthropic key, `settings.env` and the token key are shared.
- **Inbox** (`/inbox`): anything you add with **c** that names no person and no day lands here instead of on your lists. Give it You owe or Waiting on, a person and a date and move it, or delete it.
- **Automatic links** (on by default, Settings › Notes, links and sync): notes link people (`[[Nitin]]`), meetings (`[[2026-11-25 Standup|Standup]]`) and decisions (`[[decisions#^d-1a2b3c4d|decision log]]`), and the brief writes `people/<Name>.md` and `meetings/<date> <title>.md` so backlinks work in Obsidian. Decisions logged before links were on have no block id. Turn it off for the plain notes.
- **Templates** (Settings › Edit templates): the daily note, weekly recap and meeting note use `{{field}}`, `{{#if}}…{{else}}…{{/if}}`, `{{#each}}…{{/each}}` templates with a live preview, kept in `.daily-brief/templates/`. The defaults write exactly the notes as before. A broken template never stops a brief: the default is used and Settings says why.
- **Folder sync** (off by default): after each brief, daily notes, `decisions.md`, weekly recaps and `people/`, `meetings/` pages are copied one way into `<folder>/daily-brief/` (an iCloud Drive folder or an Obsidian vault). Writes are atomic and skipped when unchanged; only files it put in `daily-brief/` are ever removed.
- **Git**: if the notes folder is a git repo (`git init` in it), each brief commits the notes it wrote as “Daily brief 2026-11-26” with your git name and email. **Then push** is off by default and pushes to a named remote (default `origin`) with your own git credentials; the app never stores a URL or token, and git is never allowed to prompt, so a push that needs a password is skipped and reported in Settings.

## Delivery: email, Slack, Telegram, WhatsApp

The brief is always written to `~/Daily Brief` with a Mac notification. **Settings › Delivery** can also send it where you already are. Every channel is off until you turn it on, and each one chooses what it gets: the **Daily brief**, the **Evening wrap** (the day's promises made, kept and late), and the **Friday recap**. They go out at your brief time, after the note is written. Each channel works on its own: if Slack fails, email still goes, the brief is still marked sent, and **Settings › Health › Delivery** shows the failure (the error is logged with tokens removed). Nothing is sent twice for the same day. **Send test** saves the form and sends today's brief (or wrap, or recap) marked "Test".

Tokens and passwords go to the Keychain (service `app.dailybrief`, accounts `CHANNEL_*`), never to `channels.json` (`.daily-brief/channels.json` holds only the non-secret settings). Off a Mac (development on Linux) they go to `.daily-brief/channel-secrets.json`, readable only by you. Links in messages point to this Mac (`http://localhost:4242`), so they open only here.

- **Email:** your own SMTP server or a Resend API key. Gmail: turn on 2-Step Verification, make an app password at myaccount.google.com/apppasswords, then smtp.gmail.com, port 587, STARTTLS, your address as user. Resend: verify a domain, create a sending key, use an address on that domain as From. The email is the same HTML and text email the hosted build used, with an Open link per item.
- **Slack:** create an app at api.slack.com/apps. With a **bot token** (`xoxb-`, scopes `chat:write`, `im:write`, `users:read`, and `users:read.email` to find people by email) and your member ID, the brief arrives as a DM from the app, in Block Kit, with item quotes collapsed into one attachment. Or paste an **incoming webhook** URL to post to one channel.
- **Telegram:** make a bot with @BotFather, message it once, and read your chat ID from `https://api.telegram.org/bot<token>/getUpdates`. Items are numbered and quotes sit in collapsed blockquotes. Turn on **Close items from Telegram** to reply `/done 3`: the app asks Telegram for replies every 5 minutes (no webhook, nothing listens on your Mac) and only messages from your chat count.
- **WhatsApp** (Meta WhatsApp Cloud API): create a Business app with WhatsApp at developers.facebook.com, note the phone number ID, add your number, and make a permanent system-user token with `whatsapp_business_messaging`. Create a **Utility** template named `daily_brief` (English) with the body `Daily brief, {{1}}: {{2}} {{3}}`: the date, a one-line summary, and the link you set (empty means "Open Daily brief on your Mac"). Meta must approve the template before sends work.

**Nudges on Slack.** With a Slack bot token saved, a nudge draft shows **Send on Slack…**. It looks the person up in your workspace (or by email), then a dialog shows the recipient and the exact text. Nothing is sent until you press **Send** in that dialog, every time; the confirmation is signed for that person and that text and works once, for ten minutes. With a user token (`xoxp-`, same scopes as user scopes) it is sent as you; otherwise the app sends it, starting "From <your name>:".

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

These use your Anthropic key and the same model as extraction (`EXTRACTION_MODEL`). Only stored items go to Claude (text, person, quote, meeting title and date), never transcripts, and nothing is ever sent to anyone unless you confirm it (see Nudges on Slack above).

- **Ask** (`/ask`, or ⌘K then type a question and pick *Ask*): Claude answers from up to 40 matching items, found locally with search, and cites them as [1], [2], each linking to the item with its quote. When nothing matches it says "I don't see that in your meetings" without calling Claude. The page shows the estimated and actual cost; about ₹0.5-1.5 a question with the default model.
- **Nudges**: once a day, after the brief, each thing you're waiting on that is 3+ days overdue gets a short Slack-style nudge draft (Hinglish if the quote was), shown on the item with Copy and Start this. Drafted once per item and kept in `.daily-brief/ai.json`; at most 10 a day, about ₹0.2-0.5 each.
- **Changed decisions**: a new decision is compared with earlier ones on the same topic (word overlap, locally); only when one is similar does Claude get one small call to judge it. Today then shows "This may change the decision from 20 Nov: …" with *Keep both* or *Mark old as replaced*. About ₹0.2-0.5 per similar decision (at most 10 calls a run); decisions from before you turned this on are never checked.

A Claude skill for the MCP tools is in `skills/daily-brief/SKILL.md` (meeting prep, weekly review, and how to quote evidence).

## Check names (people directory)

Transcription misspells names ("Mangku", "Mungu", "Munkku") and sometimes guesses a name that is really someone you already know, or someone new. People shows **"N names to check"**: open it (`/people/review`) and say who each name is:

- **Same as …** (keys `1`–`3`, or `p` to pick anyone): the name becomes another spelling of that person. Suggestions are ranked by how the names sound (th/t, ee/i, a/u, doubled letters), spelling, first name and shared meetings.
- **New person** (`n`, optional email), **Rename** (`r`, fix the spelling), **Not a person** (`i`, transcription noise: its items show no name).
- `j`/`k` move, `u` undoes the last answer; every answer has its own Undo. Names with no look-alike can be confirmed in one go.

On a person's page, **Merge or split** merges them into someone else, moves selected items to another (or a new) person, and edits name, email and note. Items always keep the name as it was heard; every page, search, the prep card, person hover and the MCP tools show it through the directory. New meetings are read with your confirmed people and their spellings, so names come back as you spell them. People hides anyone with nothing open and nothing in the last 30 days behind **Show everyone**; names not checked yet carry a small "check" mark. No directory (nothing checked yet) means names show exactly as before. Generic transcription labels ("Speaker 5", "Speaker A", "Unknown", "Participant 2", "Guest") are never people or review cards: their items show "someone (unlabelled speaker)" (the stored name is kept), and Check names lists them under a collapsed "N unlabelled speakers hidden" note. A Split can still give such an item to a real person. Calendar attendees (prep, Recurring, due hints, tomorrow at a glance) also show through the directory, and confirmed people are never merged by a first-name guess. A `[[person:X]]` link always opens a page: a confirmed person with nothing yet shows "No items yet"; an unknown name offers "Add as a new person" or "Or it's someone you know".
## Send to Jira, Linear, Notion or Todoist

Settings › **Send to** connects each service with your own token. All four are off until you add one. Tokens are kept in the macOS Keychain (service `app.dailybrief`); outside the Mac app, in `.daily-brief/secrets.json` (0600). **Save and test** checks the token and switches the service on only when it works.

| Service | You need | Where tickets go |
| --- | --- | --- |
| Jira Cloud | site, your Atlassian email, an API token (id.atlassian.com › Security), project key | an issue of the type you pick (Task by default) |
| Linear | a personal API key (Settings › Security & access), team key | an issue in that team |
| Notion | an internal integration secret (notion.so/profile/integrations), a database shared with it | a page in that database |
| Todoist | the API token (Settings › Integrations › Developer), optionally a project id | a task (Inbox by default) |

Then every open item has **Send to …** in its actions (under **…** on a phone), in the **Start this** panel and on its History page. The ticket gets the item as its title, the quote, the meeting and date, the due date and a link back to the item on this Mac, and is assigned to the person when exactly one user there has that name (you, for things you owe). The item then shows **Ticket: LIN-123**. When the ticket is closed there, the item closes here with "Closed in Linear": checked every 30 minutes, only for open items with a ticket.

## Local API and webhooks

- **Local API:** Settings › Local API › **Create a token** turns on a REST API at `http://localhost:4242/api/v1` (`/items`, `/decisions`, `/people`, `/meetings`, `POST /items`, `PATCH /items/:id`). Only localhost, 120 requests a minute, other websites refused. See [docs/API.md](docs/API.md) for curl examples.
- **Webhooks:** Settings › Webhooks posts signed JSON (HMAC-SHA256) to your URLs when an item is created or closed, or a decision is made. Off by default; failed deliveries are retried for about 7 hours. Verifying the signature is in [docs/API.md](docs/API.md#webhooks).

Non-secret settings for these live in `.daily-brief/integrations.json`.

## Other recorders: Granola, Zoom, Google Meet, phone calls

Settings > Other recorders reads meetings recorded outside Wispr Flow. Each source is off until you turn it on, everything is read on this Mac, and transcripts are read from their files when a meeting is read, never copied into the app's data.

| Source | What it reads | Where |
| --- | --- | --- |
| Granola | Meetings and transcripts in Granola's local cache | `~/Library/Application Support/Granola/cache-v*.json` (the newest version) |
| Zoom recordings | `.vtt` transcripts and saved closed captions, one meeting per recording folder | `~/Documents/Zoom` (change it in Settings) |
| Google Meet and transcript files | Any `.docx`, `.txt`, `.vtt`, `.srt` or `.md` dropped in the inbox, or uploaded in Settings. For Meet: open the transcript in Google Docs, File > Download > Microsoft Word | `~/Daily Brief/inbox/` |
| Phone calls | Call transcripts as text (iOS Notes, Just Press Record) | `~/Daily Brief/inbox/phone/`, or a name like "Call with Ravi.txt" |

- Turning Granola or Zoom on reads the last 7 days, not the whole history (each meeting is one AI read, about ₹3.50). Settings shows how many it found first.
- A meeting's title comes from its title line or heading, else the file name; its time from the contents, else the file name ("2026-11-24 10.00.00 …", "GMT20261124-043000"), else the file's modified time less the recording's length.
- The same meeting recorded twice (say Wispr Flow and Granola: starts within 10 minutes and alike titles) is read once.
- Files are checked every 5 minutes by modified time; a file that changed in the last minute waits for the next check.
- Granola's cache is not a public format. The shape we expect is written down in `src/server/recorders/granola.ts`; if it changes, Settings says it couldn't read it and nothing else happens.
- Google Meet straight from Google Drive (without downloading) needs Google sign-in, which isn't built yet.

## The command line

`daily-brief` reads and writes the same `state.json` as the app (the app picks up changes on its next read).

```bash
npm run cli:install          # links bin/daily-brief into /opt/homebrew/bin or ~/.local/bin (prints the command; never sudo)
daily-brief today            # Top 3, You owe, Waiting on, Decisions, Closed today
daily-brief owe tarun        # most pressing first; waiting [person] works the same way
daily-brief decisions --since 2026-11-01 banner
daily-brief search "payout" --all
daily-brief person Nitin
daily-brief add "send Nitin the deck by Fri"
daily-brief done 1a2b3c4d    # also: wrong, undo, star, unstar, snooze <id> tomorrow|mon|next week|2026-12-01|off
daily-brief ask "what did I promise Priya this week?"
daily-brief open review      # opens the app (or an item: open <id>)
```

Without installing: `npm run -s cli -- today`. Reads take `--json`; `--limit N` and `--no-color` work everywhere. Colours only show on a terminal (and never with `NO_COLOR`). Ids are the 8 characters at the end of each item's second line. `ask` is the only command that calls the Anthropic API: it uses `ANTHROPIC_API_KEY`, or the key you saved in Settings (Keychain), and costs about the same as Ask in the app.

## Priority and Top 3

You owe on Today and in `daily-brief owe` is ordered by a local score: overdue (more the later it is), due within a day or three, starred, how many other things the same person is waiting on from you, and how long it has been open. The three highest show as "Top 3 today" above You owe; hover one to see why. No API calls.

## Monthly review and Year in review

Review in the sidebar opens `/review/month/YYYY-MM` (and `/review/year/YYYY`): promises made, kept, late and closed by meetings, the people you promised most, decisions by week or month, the longest-open and fastest-closed items. Download HTML saves the review as one static file to share. Quotes from meetings are left out unless you press Include quotes first.

## The Mac app

`Daily Brief.app` is a small Tauri window and menu bar item around the same server. It starts the server with the Node.js runtime it carries inside (Node 22 LTS, so you don't need Node installed to run it), or reuses one already running on port 4242, and stops the one it started when you quit. Closing the window keeps it in the menu bar, where you also find **Check meetings now**, **Open in browser** and **Launch at login**.

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

**What `mac:build` does.** It builds the standalone server, downloads the pinned Node runtime (`NODE_VERSION` in `scripts/node-runtime.mjs`; just the `node` binary and its license, no npm) from nodejs.org, checks it against the official `SHASUMS256.txt`, and caches it in `src-tauri/target/node-cache` so the next build doesn't download it again. That adds about 108 MB to the .app (about 40 MB to the .dmg). Building still needs Node 18.18+ on your Mac; running the app doesn't. A build without the runtime (say `tauri dev`) falls back to your system Node. The .app is built first and the .dmg is made after it with `hdiutil`, retried a few times; if the .dmg still fails you get the .app anyway (`scripts/make-dmg.sh` makes the .dmg again by hand).

**First launch.** The app isn't signed with an Apple Developer ID. A copy you built yourself opens normally. If macOS says it can't be opened (say, you copied it from another Mac): right-click (or Control-click) the app in Finder, choose **Open**, then **Open** again. Or allow it under System Settings › Privacy & Security › **Open Anyway**, or run `xattr -dr com.apple.quarantine "/Applications/Daily Brief.app"`.

## Windows and Linux

The same app builds for Windows (x64) and Linux (AppImage and .deb), each with Node bundled.
`.github/workflows/desktop.yml` builds macOS (Apple Silicon), Windows and Linux. Run it on any
branch from Actions › Desktop builds › **Run workflow** (or `gh workflow run desktop.yml --ref <branch>`)
and download the installers from the run's artifacts. Pushing a version tag does the same and
attaches the installers to a draft GitHub release:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

To build one yourself: `node scripts/stage-server.mjs` (the standalone server),
`node scripts/node-runtime.mjs` (the bundled Node for this machine; `--target <triple>` for another),
then `npx tauri build`. On Linux first install `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf libxdo-dev libssl-dev`.

What differs per system:

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Node.js | Bundled; else Homebrew or your shell's PATH (18.18+) | Bundled; else Program Files, nvm-windows, Volta, or `where node` | Bundled; else /usr/bin, /usr/local/bin, Volta, snap, or your login shell (nvm) |
| Secrets | Keychain | Credential Manager (`app.dailybrief:<NAME>`) | Desktop keyring through `secret-tool` (package `libsecret-tools`) |
| Notifications | Notification Center | Toast | `notify-send` (package `libnotify-bin`) |
| Launch at login | LaunchAgent | Run key in the registry | `~/.config/autostart` |
| Log | `~/Library/Logs/daily-brief.log` | `%LOCALAPPDATA%\Daily Brief\daily-brief.log` | `~/.local/state/daily-brief/daily-brief.log` |

Put your key in the secret store with `npm run keychain:import` (from a checkout with `.env.local`),
or by hand: `cmdkey /generic:app.dailybrief:ANTHROPIC_API_KEY /user:ANTHROPIC_API_KEY /pass` on
Windows, `secret-tool store --label="Daily brief ANTHROPIC_API_KEY" service app.dailybrief account ANTHROPIC_API_KEY`
on Linux. Your notes folder is `~/Daily Brief` on every system. The builds are unsigned: Windows
SmartScreen asks once (**More info › Run anyway**); on Linux, `chmod +x` the AppImage.

## Keep it running at login without the app

`npm run install-login` sets up a launchd agent (`app.dailybrief`) that runs `npm start` at login. The Mac app replaces it: turn on **Launch at login** in the menu bar, and remove the agent with `npm run uninstall-login`. While the agent runs, the app reuses its server.

## Hosted version (for friends)

The same app can run on Vercel + Supabase for a few people, with nothing to install: sign in with an email link, connect your own Wispr Flow, get the brief by email (or Slack). Set `DAILY_BRIEF_MODE=hosted`; without it the app is the local Mac app, unchanged. Optional billing (Razorpay **test mode** only, ₹500/month, free tier of 20 meetings, referral codes) and teams (shared decisions, who owes whom, manager brief, audit log) are off until you turn them on.

Setup, step by step: [docs/HOSTED.md](docs/HOSTED.md). Check your settings with `npm run hosted:check`, create the tables with `npm run hosted:migrate`.

## Develop

`npm test`, `npm run typecheck`, `npm run lint`, `npm run eval` (extraction accuracy on real meetings; see `eval/README.md`).

The hosted version (Supabase, email, Vercel cron) lives on the `sprint-1` branch.
