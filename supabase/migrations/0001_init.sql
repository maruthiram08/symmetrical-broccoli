-- Sprint 1 schema. See the Sprint 1 PRD, "Technical design".
create extension if not exists pgcrypto;

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null default '',
  aliases text[] not null default '{}',
  time_zone text not null default 'Asia/Kolkata',
  brief_time text not null default '18:00' check (brief_time ~ '^[0-2][0-9]:(00|15|30|45)$'),
  created_at timestamptz not null default now()
);

create table connections (
  user_id uuid not null references users(id) on delete cascade,
  provider text not null check (provider in ('wispr_flow')),
  access_token text not null,   -- encrypted (AES-256-GCM, key in TOKEN_ENCRYPTION_KEY)
  refresh_token text not null,  -- encrypted
  expires_at timestamptz not null,
  last_seen_at timestamptz,
  status text not null default 'active' check (status in ('active','needs_reconnect')),
  oauth_client jsonb,           -- dynamic client registration result
  primary key (user_id, provider)
);

create table meetings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider_meeting_id text not null,
  title text not null,
  started_at timestamptz not null,
  participants text[] not null default '{}',
  processed_at timestamptz,
  unique (user_id, provider_meeting_id)
);
create index meetings_unprocessed on meetings(user_id) where processed_at is null;

create table items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('owe','waiting','decision')),
  text text not null,
  person text,
  quote text not null check (char_length(quote) <= 200),
  meeting_id uuid not null references meetings(id) on delete cascade,
  due_at timestamptz,
  status text not null default 'open' check (status in ('open','done','wrong')),
  closed_by_meeting_id uuid references meetings(id) on delete set null,
  close_quote text check (close_quote is null or char_length(close_quote) <= 200),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index items_open on items(user_id) where status = 'open';

create table briefs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  date date not null,
  markdown text not null,
  sent_at timestamptz,
  email_id text,
  unique (user_id, date)
);

create table events (
  id bigint generated always as identity primary key,
  user_id uuid references users(id) on delete cascade,
  type text not null check (type in ('wrong_click','done_click','undo','extract_run','brief_sent','backfill')),
  payload jsonb not null default '{}',
  tokens_in int,
  tokens_out int,
  cost_inr numeric(10,4),
  created_at timestamptz not null default now()
);

-- Only the server (service role) touches these tables.
alter table users enable row level security;
alter table connections enable row level security;
alter table meetings enable row level security;
alter table items enable row level security;
alter table briefs enable row level security;
alter table events enable row level security;
