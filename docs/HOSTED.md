# Daily brief, hosted

The same code as the Mac app, run on Vercel + Supabase for a few friends: they sign in with an
email link, connect their own Wispr Flow, and get the daily brief by email (and Slack, if they
want) with nothing to install. One switch picks the mode:

```
DAILY_BRIEF_MODE=local    # default: the Mac app, unchanged
DAILY_BRIEF_MODE=hosted   # this document
```

What changes in hosted mode:

| | Local (Mac) | Hosted |
| --- | --- | --- |
| Data | `~/Daily Brief/.daily-brief/state.json` | Supabase Postgres, one row set per user, row-level security |
| Sign-in | none (one user) | email magic link (Supabase Auth), every page behind it |
| Wispr Flow tokens | local file, local key | per user, AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY` |
| Jobs | in-process scheduler, file lock | Vercel Cron → `/api/cron/poll` (30 min), `/api/cron/deliver` (15 min); a Postgres advisory lock per user, 3 users at a time |
| Brief | `.md` note + Mac notification | email (Resend), optional Slack webhook |
| Anthropic key | yours, in Keychain | the server's (`ANTHROPIC_API_KEY`), about ₹3.50 a meeting |
| Billing, teams | – | optional, off by default |

Things that stay local-only: the Mac app and menu bar, Markdown notes on disk, the MCP server for
Claude, Keychain. "Pull meetings since" and "Re-read all" work, but their live progress bar is
local-only (hosted runs them in the background; the meetings appear when done).

---

## What you need to do (about 45 minutes)

You need accounts at Supabase, Vercel, Resend and (only for billing) Razorpay, and the repo on
GitHub. Nothing below costs money except Vercel Pro, which the 15/30-minute crons need (see step 5
for the free alternative).

### 1. Supabase (database + sign-in)

1. Create a project at https://supabase.com (region: Mumbai `ap-south-1` for India). Save the
   database password.
2. **Project Settings › API**: copy the *Project URL* → `SUPABASE_URL`, the *anon public* key →
   `SUPABASE_ANON_KEY`, and the *service_role* key → `SUPABASE_SERVICE_ROLE_KEY` (optional: only
   used so "Delete my account" also deletes the sign-in account).
3. **Project Settings › Database › Connection string**: choose **Session pooler** (port **5432**,
   not 6543: the per-user job locks need a session) and copy it with your password filled in →
   `DATABASE_URL`.
4. Same page, **SSL configuration › Download certificate** → paste the PEM into `DATABASE_CA_CERT`
   (newlines may be written as `\n`). Without it the connection is encrypted but not verified;
   `hosted:check` warns.
5. **Authentication › URL Configuration**: Site URL = your app URL (step 3), and add
   `https://YOUR-APP/auth/callback` to Redirect URLs.
6. **Authentication › Emails › SMTP Settings**: turn on custom SMTP with Resend (step 2:
   host `smtp.resend.com`, port 465, user `resend`, password = your Resend API key). Supabase's
   built-in mailer only sends a few emails an hour.
7. Optional, so the link works in any browser (not just the one that asked for it): in
   **Authentication › Emails › Magic Link**, change the link to
   `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=magiclink`.

### 2. Resend (email)

1. Sign up at https://resend.com, **Domains › Add domain**, add the DNS records it shows and wait
   for *Verified*.
2. **API Keys › Create** → `RESEND_API_KEY`.
3. `EMAIL_FROM` = `Daily brief <brief@your-domain>`.

### 3. Vercel (the app)

1. **Add New › Project**, import the GitHub repo, framework Next.js, default build settings.
2. **Settings › Environment Variables**: add everything in the table below (Production). Then
   redeploy. Your URL (e.g. `https://daily-brief-yourname.vercel.app`, or a custom domain) is
   `APP_URL`; set it, redeploy once more.
3. `vercel.json` already declares the two crons. Vercel sends `Authorization: Bearer $CRON_SECRET`
   to them automatically when `CRON_SECRET` is set.

### 4. Run the migrations

On your Mac, in the repo:

```bash
cp docs/hosted.env.example .env.hosted      # fill it in (same values as Vercel); git ignores it
npm run hosted:check                       # every variable present and sane
npm run hosted:migrate                     # applies supabase/migrations/*.sql, each once
npm run hosted:check -- --connect          # database reachable, all migrations applied
```

(Or paste the files in `supabase/migrations/` into Supabase's **SQL Editor**, in order.
`hosted:migrate` just remembers what ran, in `_daily_brief_migrations`.)

### 5. Crons

Vercel **Pro** runs `vercel.json`'s crons as written. On the free **Hobby** plan crons may run
only once a day, so instead use a free external scheduler (e.g. https://cron-job.org) with two
jobs, each with header `Authorization: Bearer <CRON_SECRET>`:

- `GET https://YOUR-APP/api/cron/poll` every 30 minutes
- `GET https://YOUR-APP/api/cron/deliver` every 15 minutes

and delete the `crons` block from `vercel.json`. Hobby functions stop after 60 seconds, so each
poll run reads fewer meetings; the next run carries on.

### 6. Let your friends in

Put their emails in `ALLOWED_EMAILS` (comma-separated) and send them the URL. Each one: signs in
with the email link → name, time zone and brief time → **Connect Wispr Flow** (their own account)
→ how far back to read. The brief arrives at their brief time. **Account** has email/Slack
delivery, *Download my data* and *Delete my account*.

### 7. Billing (optional, test mode only)

Billing is off by default: everyone has everything. To try the ₹500/month plan:

1. Razorpay dashboard in **Test Mode**: **Subscriptions › Plans › Create** (monthly, ₹500) →
   `RAZORPAY_PLAN_ID`. **Account & Settings › API Keys** (test) → `RAZORPAY_KEY_ID`
   (`rzp_test_…`) and `RAZORPAY_KEY_SECRET`.
2. **Webhooks › Add**: URL `https://YOUR-APP/api/billing/webhook`, a secret →
   `RAZORPAY_WEBHOOK_SECRET`, events `subscription.*`.
3. `BILLING_ENABLED=1`. Free plan: `FREE_MEETINGS_PER_MONTH` (20) meetings read a month; later
   ones wait unread until the 1st or until they subscribe. Each user gets a referral code on
   **Plan**: a friend who uses it gets a free month (`REFERRAL_FREE_DAYS`, 30), and the referrer
   gets one when that friend is first charged.

Live keys (`rzp_live_…`) are refused by `hosted:check` and by the code itself: this build cannot
take real money. Pay with Razorpay's test cards.

### 8. Teams (optional)

`TEAMS_ENABLED=1` adds **Team**: create a team, invite by email (they join on their next
sign-in), roles owner/admin/member. A member shares an item from its page; only shared items show
in the team's **Decisions** log and **Who owes whom**. Admins can turn on the **manager brief**
(one line per member who opted in, from their shared open items, in the admins' daily email).
Every change is in the **Audit log**.

---

## Environment variables

| Variable | Needed | What |
| --- | --- | --- |
| `DAILY_BRIEF_MODE` | yes | `hosted` |
| `APP_URL` | yes | `https://…` public URL, no trailing slash |
| `DATABASE_URL` | yes | Supabase session pooler URL (port 5432) |
| `DATABASE_CA_CERT` | recommended | Supabase CA certificate (PEM) |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | yes | sign-in emails |
| `SUPABASE_SERVICE_ROLE_KEY` | optional | delete the sign-in account on "Delete my account" |
| `SESSION_SECRET` | yes | 32+ random characters: `openssl rand -base64 48` |
| `TOKEN_ENCRYPTION_KEY` | yes | `openssl rand -base64 32` (keep it: losing it means everyone reconnects Wispr Flow) |
| `CRON_SECRET` | yes | 24+ random characters: `openssl rand -hex 24` |
| `ANTHROPIC_API_KEY` | yes | reads meetings |
| `RESEND_API_KEY`, `EMAIL_FROM` | yes | the brief email |
| `ALLOWED_EMAILS` | recommended | who may sign in; empty = anyone |
| `WISPR_MCP_URL` | no | default `https://api.wisprflow.ai/connect/mcp` |
| `HOSTED_CONCURRENCY` | no | users processed at once per cron run (3) |
| `BILLING_ENABLED`, `RAZORPAY_*`, `PRICE_INR`, `FREE_MEETINGS_PER_MONTH`, `REFERRAL_FREE_DAYS` | billing | see step 7 |
| `TEAMS_ENABLED` | teams | see step 8 |

## How it fits together

- `src/server/mode.ts`: the switch. `src/server/local/app.ts` (`getStore`, `me`, `buildDeps`,
  `wisprAuthContext`) hands over to `src/server/hosted/app.ts` when hosted, so pages and jobs are
  shared.
- `src/server/app-store.ts`: the `AppStore` interface both stores implement.
  `src/server/hosted/store.ts` (`HostedStore`) is the Postgres one; a store *scoped* to the
  signed-in user refuses any other user's id.
- `src/server/hosted/jobs.ts`: the cron runs (same `pollUser` / `processPending` / `deliverUser`
  as the Mac), `withUserLock` in `db.ts` (session advisory lock; released if the function dies).
- `src/middleware.ts`: hosted pages need a session (`db_session`, HMAC-signed, 30 days).
- `supabase/migrations/`: `0001` core tables, `0002` billing and teams, `0003` row-level security, `0004` fields the local app gained since (recorder, duplicates, tickets)
  (the server connects as the owner; RLS guards anything reaching the tables through Supabase's
  REST API with the anon key or a user's token: own rows only, secrets never).

## Testing

`npm test` covers the hosted store, billing, teams, cron runs, sign-in and delivery against an
in-memory Postgres (pg-mem) and mocked HTTP (no real Supabase, Resend, Razorpay or Wispr calls).
With a throwaway Postgres you can also run the real-database checks (migrations incl. RLS,
transactions, advisory locks):

```bash
HOSTED_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres npx vitest run src/server/hosted/store.pg.test.ts
```
