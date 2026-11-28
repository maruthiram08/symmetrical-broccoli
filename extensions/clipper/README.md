# Daily brief web clipper

A small Manifest V3 extension for Chrome (and Chromium browsers) and Firefox. It clips the text you selected, or the page's readable article, as Markdown into your Daily brief notes: appended to the workspace's **Inbox** note (`notes/inbox.md`), or saved as a new note.

It talks only to Daily brief on this computer, through the local API (`POST /api/v1/clips`, see `docs/API.md`), with the token you paste once. It isn't published in any store: you load it from this folder.

## Install

**Chrome, Edge, Brave, Arc**

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked**, and pick this folder (`extensions/clipper`).

**Firefox** (121 or later)

1. Open `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…**, and pick `extensions/clipper/manifest.json`. (Temporary add-ons go away when Firefox restarts. To keep it, sign it yourself with `web-ext sign`.)
3. In `about:addons` › Daily brief clipper › **Permissions**, allow access to `localhost` and `127.0.0.1`. Firefox asks for host access separately.

## Set up (once)

1. In Daily brief, **Settings › Local API › Create a token**. Copy it.
2. Open the clipper's **Options** (right-click the toolbar icon › Options). Paste the token. The address is `http://localhost:4242` unless you changed the port.
3. The options page shows the extension's origin (`chrome-extension://…` or `moz-extension://…`). Paste it into **Settings › Local API › Also allow these browser origins** and save. The API refuses browser origins it doesn't know, so web pages can't read your brief.

## Use

Click the toolbar icon, choose **Selection** (falls back to the article when nothing is selected) or **The readable article**, choose **Inbox note** or **A new note**, then **Clip**.

Each clip adds a heading with the page title, a line saying where it came from and when, and the Markdown. Links stay links; scripts, forms, navigation and images inside `data:` URLs are dropped. Only `http`, `https` and `mailto` links are kept.

## Privacy

- Page content is read only when you press **Clip** (the `activeTab` permission), and only from the tab you're on.
- The token is kept in the extension's local storage on this computer (not synced), and is only sent to `localhost` / `127.0.0.1`.
- Nothing goes anywhere but Daily brief on this computer.

## Files

- `manifest.json`: MV3, works in both browsers (`browser_specific_settings.gecko` for Firefox).
- `lib/markdown.js`: selection / article to Markdown, injected into the page. Unit tested in `src/server/integrations/clipper.test.ts`.
- `lib/api.js`: the call to `/api/v1/clips`.
- `popup.*`, `options.*`: the two small pages.
