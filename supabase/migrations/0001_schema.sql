-- Daily brief, hosted mode: core tables. Mirrors the local FileStore (src/server/local/file-store.ts)
-- one table per thing it keeps. Row-level security and functions are in 0003_security.sql.
-- users.id is the Supabase Auth user id (auth.users.id), so RLS can compare it with auth.uid().

create table users (
  id uuid primary key,
  email text not null unique,
  name text not null default '',
  aliases text[] not null default '{}',
  time_zone text not null default 'Asia/Kolkata',
  brief_time text not null default '18:00',
  include_shared boolean not null default false,
  -- Delivery: email on by default; Slack incoming webhook (encrypted, optional).
  deliver_email boolean not null default true,
  slack_webhook text,
  -- Billing: free months from referrals or a hand-given comp.
  comp_until timestamptz,
  referral_code text unique,
  created_at timestamptz not null default now()
);

create table connections (
  user_id uuid not null references users(id) on delete cascade,
  provider text not null default 'wispr_flow',
  access_token text not null,    -- encrypted (AES-256-GCM, TOKEN_ENCRYPTION_KEY)
  refresh_token text not null,   -- encrypted
  expires_at timestamptz not null,
  last_seen_at timestamptz,
  status text not null default 'active',
  refresh_failures integer not null default 0,
  oauth_client text,             -- encrypted JSON of the dynamic client registration
  primary key (user_id, provider)
);

create table meetings (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  provider_meeting_id text not null,
  title text not null,
  started_at timestamptz not null,
  participants text[] not null default '{}',
  processed_at timestamptz,
  link text,
  shared boolean not null default false,
  owner_name text,
  failed_attempts integer not null default 0,
  last_failed_at timestamptz,
  last_failure text,
  unique (user_id, provider_meeting_id)
);
create index meetings_user_started on meetings(user_id, started_at);

create table items (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null,
  text text not null,
  person text,
  quote text not null default '',
  -- A meeting id, or 'manual' for items you added yourself (so no foreign key).
  meeting_id text not null,
  due_at timestamptz,
  status text not null default 'open',
  closed_by_meeting_id text,
  close_quote text,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  source text not null default 'extracted',
  note text,
  starred boolean not null default false,
  snoozed_until text
);
create index items_user on items(user_id, status);

create table briefs (
  user_id uuid not null references users(id) on delete cascade,
  date text not null,
  markdown text not null,
  sent_at timestamptz,
  email_id text,
  primary key (user_id, date)
);

create table events (
  id bigserial primary key,
  user_id uuid references users(id) on delete cascade,
  type text not null,
  payload jsonb not null default '{}',
  tokens_in integer,
  tokens_out integer,
  cost_inr numeric,
  created_at timestamptz not null default now()
);
create index events_user_type on events(user_id, type);

-- When each user last looked at Today (the close moment).
create table looks (
  user_id uuid primary key references users(id) on delete cascade,
  last_looked_at timestamptz not null,
  since timestamptz
);

-- Hand-made Done/Wrong/star/snooze kept across a re-read of every meeting.
create table marks (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  meeting_id text not null,
  kind text not null,
  text text not null,
  quote text not null default '',
  status text not null,
  closed_at timestamptz,
  starred boolean not null default false,
  snoozed_until text
);
create index marks_meeting on marks(user_id, meeting_id);

-- Upcoming-meeting and calendar caches written by the poll (JSON, as in the local store).
create table caches (
  user_id uuid not null references users(id) on delete cascade,
  kind text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind)
);

create table prep_notified (
  key text primary key,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- What the jobs last managed to do (Health section and banners), per user.
create table health (
  user_id uuid primary key references users(id) on delete cascade,
  data jsonb not null default '{}'
);

-- Nudge drafts, changed-decision flags and their bookkeeping (src/server/local/ai-store.ts), per user.
create table ai_state (
  user_id uuid primary key references users(id) on delete cascade,
  data jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- Wispr Flow dynamic client registration per user (encrypted JSON).
create table oauth_clients (
  user_id uuid primary key references users(id) on delete cascade,
  data text not null
);
