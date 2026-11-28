# Phone widget

Daily brief can put one line on your phone: **3 you owe today · 1 overdue**. It comes from
`/api/widget`, a small JSON endpoint that needs a widget token. A widget token can read that line
and nothing else: not your items, not your settings.

## What you need

1. Your phone and your Mac on the same Wi-Fi (or the same Tailscale network, see the README).
2. On the Mac: **Settings › Phone access** turned on. Note the address it shows, like `http://192.168.1.20:4243`.
3. On the Mac: **Settings › Phone widget › Create widget token**. Copy the token now; it is shown once.
   To revoke it later, press **Remove** next to it.

## What the endpoint returns

```bash
curl -H "Authorization: Bearer <token>" http://192.168.1.20:4243/api/widget
```

```json
{
  "text": "3 you owe today · 1 overdue",
  "owe": 3,
  "overdue": 1,
  "waiting": 2,
  "next": "Send Nitin the pricing deck",
  "date": "2026-11-26",
  "updatedAt": "2026-11-26T09:41:00.000Z",
  "title": "3"
}
```

`owe` counts what Today shows under *You owe* (overdue ones included); `overdue` is how many of
those are late. Without a valid token you get HTTP 401.

## iOS Shortcut recipe

In the **Shortcuts** app, tap **+** and add these actions:

1. **Get Contents of URL**
   - URL: `http://192.168.1.20:4243/api/widget` (your address from Settings)
   - Method: `GET`
   - Headers: add `Authorization` with the value `Bearer <your token>`
2. **Get Dictionary Value**: Get **Value** for **text** in **Contents of URL**
3. **Show Result** (or **Show Notification**) with **Dictionary Value**

Name it **Daily brief**. Then:

- **Home Screen:** long-press the Home Screen › **+** › **Shortcuts** › pick **Daily brief**. Tapping it shows the line.
- **Every morning:** Shortcuts › **Automation** › **+** › **Time of Day** (say 9:00) › **Run Immediately** › run **Daily brief**, ending in **Show Notification**.
- **Siri:** "Hey Siri, Daily brief".

Want the line itself on the widget, refreshed by iOS? Use a widget app that runs a script, such as
Scriptable. A Scriptable widget:

```js
const req = new Request("http://192.168.1.20:4243/api/widget");
req.headers = { Authorization: "Bearer <your token>" };
let data;
try { data = await req.loadJSON(); } catch { data = { text: "Mac not reachable", overdue: 0 }; }
const w = new ListWidget();
const t = w.addText(data.text);
t.font = Font.semiboldSystemFont(16);
if (data.overdue) t.textColor = Color.red();
if (data.next) { w.addSpacer(4); w.addText(data.next).font = Font.systemFont(12); }
w.refreshAfterDate = new Date(Date.now() + 15 * 60_000);
Script.setWidget(w);
Script.complete();
```

## Android

Any app that can call a URL with a header works, such as **HTTP Shortcuts** (a home-screen
shortcut or widget showing the `text` field) or **KWGT** with a web-get formula.

## On the Mac

The menu bar item shows the same count as its title (say **3**), refreshed every minute and right
after **Check meetings now**. It shows nothing when you owe nothing today.

## Notes

- The endpoint only answers through Phone access (the LAN address) or on the Mac itself. With Phone
  access off, the phone can't reach it at all.
- Over plain Wi-Fi the token travels unencrypted. Use it on networks you trust, or set up HTTPS (README › Phone).
