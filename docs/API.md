# Daily brief local API and webhooks

The app serves a small REST API on this Mac, at `http://localhost:4242/api/v1`, for your own scripts, Raycast commands, Shortcuts or dashboards. It's **off** until you create a token, and it never leaves your machine.

- **Turn it on:** Settings › Local API › **Create a token**. Copy it then: it isn't shown again. **Make a new token** replaces it (the old one stops working); **Turn off** deletes it. The token is kept in the macOS Keychain (service `app.dailybrief`, account `LOCAL_API_TOKEN`); outside the Mac app (say `npm start`) it's in `~/Daily Brief/.daily-brief/secrets.json` (0600).
- **Sign in:** send `Authorization: Bearer <token>` with every request.
- **Only localhost:** requests whose `Host` isn't `localhost`, `127.0.0.1` or `[::1]` are refused (stops DNS rebinding). A browser `Origin` other than this Mac's (or the Mac app's window) is refused too, so a web page you visit can't read your brief. You can allow your own tool's origin in Settings › Local API; allowed origins get CORS headers.
- **Rate limit:** 120 requests a minute per token, and 20 failed sign-ins a minute in all. Over the limit you get `429` with `Retry-After` (seconds). Every answer carries `X-RateLimit-Limit` and `X-RateLimit-Remaining`.
- **Errors:** JSON `{ "error": "..." }` with `400` (bad input), `401` (missing or wrong token), `403` (API off, or host/origin refused), `404`, `409` (app not set up), `429`, `500`.

```bash
export DAILY_BRIEF_TOKEN=dbk_...        # from Settings › Local API
export DB=http://localhost:4242/api/v1
```

## Items

An item is something you owe (`owe`), are waiting on (`waiting`), or a decision (`decision`).

```json
{
  "id": "6c1f…",
  "kind": "waiting",
  "text": "Nitin to share the API spec",
  "person": "Nitin",
  "quote": "Main spec bhej dunga kal tak",
  "status": "open",
  "dueAt": "2026-11-27T12:30:00.000Z",
  "createdAt": "2026-11-24T09:00:00.000Z",
  "closedAt": null,
  "closeReason": null,
  "source": "extracted",
  "note": null,
  "starred": false,
  "snoozedUntil": null,
  "meeting": { "id": "…", "title": "Banner sync", "startedAt": "2026-11-24T08:30:00.000Z" },
  "ticket": { "provider": "linear", "key": "LIN-123", "url": "https://linear.app/…" },
  "url": "http://localhost:4242/item/6c1f…"
}
```

`status` is `open`, `done` or `wrong`. `closeReason` says how it closed: the words from the meeting that closed it, `"Closed in Linear"` (its ticket closed), or `null` (you closed it, or it's open). `source` is `extracted` (read from a meeting) or `manual` (added by you).

### `GET /items`

Open things you owe and wait on, newest first.

| Query | |
| --- | --- |
| `status` | `open` (default), `done`, `wrong`, `all` |
| `kind` | `owe`, `waiting` or `decision` (default: owe and waiting) |
| `person` | a name, matched like the People page (`nitin` finds "Nitin K") |
| `since` | `YYYY-MM-DD` (start of that day in your zone) or an ISO time; items created then or later |
| `limit`, `offset` | paging; `limit` 1–500, default 100 |

```bash
curl -s -H "Authorization: Bearer $DAILY_BRIEF_TOKEN" "$DB/items?kind=waiting&person=nitin"
```

Answer: `{ "items": [...], "total": 3, "limit": 100, "offset": 0 }`.

### `GET /items/:id`

```bash
curl -s -H "Authorization: Bearer $DAILY_BRIEF_TOKEN" "$DB/items/6c1f…"
```

Answer: `{ "item": {...} }`.

### `POST /items`

Add your own item, the same as quick capture.

| Field | |
| --- | --- |
| `kind` | `owe` or `waiting` (required) |
| `text` | required, up to 300 characters |
| `person` | optional |
| `due` | optional `YYYY-MM-DD`: due 6 PM that day in your zone |
| `dueAt` | optional ISO time instead of `due` |
| `note` | optional |

```bash
curl -s -X POST -H "Authorization: Bearer $DAILY_BRIEF_TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"waiting","text":"Tarun owes me the API spec","person":"Tarun","due":"2026-11-28"}' \
  "$DB/items"
```

Answer: `201` with `{ "item": {...} }` and a `Location` header.

### `PATCH /items/:id`

Change any of: `status` (`open`, `done`, `wrong`), `starred` (true/false), `snoozedUntil` (`YYYY-MM-DD` or null), `due`/`dueAt` (or null). On items you added, also `text`, `person` and `note`; items read from a meeting are marked `wrong` instead of edited.

```bash
curl -s -X PATCH -H "Authorization: Bearer $DAILY_BRIEF_TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"done"}' "$DB/items/6c1f…"
```

Answer: `{ "item": {...} }`, as it is now.

## `GET /decisions`

Decisions, newest first. `since` (as above, by meeting date), `q` (words in the decision or quote), `limit`, `offset`.

```bash
curl -s -H "Authorization: Bearer $DAILY_BRIEF_TOKEN" "$DB/decisions?q=banner&since=2026-11-01"
```

Answer: `{ "decisions": [item, ...], "total": … }`.

## `GET /people`

Everyone named on an item, busiest first: `{ "people": [{ "name": "Nitin", "slug": "nitin", "youOwe": 1, "theyOwe": 2, "overdue": 1, "lastMeetingAt": "…", "meetingCount": 4, "url": "http://localhost:4242/people/nitin" }], … }`.

```bash
curl -s -H "Authorization: Bearer $DAILY_BRIEF_TOKEN" "$DB/people"
```

## `GET /meetings`

Meetings, newest first. `since` and `until` (`until` is not included), `limit`, `offset`. Never includes transcripts.

```bash
curl -s -H "Authorization: Bearer $DAILY_BRIEF_TOKEN" "$DB/meetings?since=2026-11-20"
```

Answer: `{ "meetings": [{ "id": "…", "title": "Banner sync", "startedAt": "…", "participants": ["Nitin Kumar"], "read": true, "shared": false, "link": "https://notes.wisprflow.ai/…", "items": { "owe": 1, "waiting": 1, "decision": 1 } }], … }`.

## Webhooks

Settings › Webhooks posts a JSON event to your URLs (up to 5) when:

| Event | When |
| --- | --- |
| `item.created` | a new thing you owe or wait on: read from a meeting, added by you, or added through the API |
| `item.closed` | an open item becomes done or wrong: a later meeting, your Done/Wrong, the API, the MCP server, or its ticket closing |
| `decision.made` | a new decision is read from a meeting |

It's off by default. Changes from before you switch it on are never sent. Changes are checked every minute (and right after an API write), so an event arrives within about a minute.

```http
POST /hooks/daily-brief HTTP/1.1
Content-Type: application/json
User-Agent: DailyBrief-Webhooks/1
X-Daily-Brief-Event: item.closed
X-Daily-Brief-Delivery: dlv_2b9c…
X-Daily-Brief-Signature: t=1764151200,v1=5f0c…

{"id":"evt_…","type":"item.closed","createdAt":"2026-11-26T10:00:00.000Z","data":{"item":{…same shape as the API…}}}
```

**Retries.** Any answer other than 2xx (a redirect counts as a failure), or no answer in 10 seconds, is retried after 30 seconds, 2 minutes, 10 minutes, 1 hour and 6 hours, then dropped. Retries are kept in `integrations.json`, so they survive a restart. Every attempt has the same `X-Daily-Brief-Delivery` id: use it to ignore repeats. **Send a test** posts a `ping` event to each URL.

**Verify the signature.** `X-Daily-Brief-Signature` is `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with your signing secret>`. Find the secret under Settings › Webhooks › **Show secret** (made for you when you first switch webhooks on; **New secret** replaces it). Compare in constant time and reject old timestamps:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(rawBody, header, secret, toleranceSec = 300) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (!t || !v1 || Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const want = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return want.length === v1.length && timingSafeEqual(Buffer.from(want), Buffer.from(v1));
}
```

```bash
# The same check in a shell: prints the signature you should have received.
printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex
```
