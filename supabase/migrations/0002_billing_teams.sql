-- Billing (Razorpay subscriptions, referrals) and teams (v3 foundation).

create table subscriptions (
  user_id uuid primary key references users(id) on delete cascade,
  provider text not null default 'razorpay',
  subscription_id text not null unique,
  plan_id text not null,
  status text not null,            -- created | authenticated | active | pending | halted | cancelled | completed | expired
  current_end timestamptz,
  updated_at timestamptz not null default now()
);

-- Every webhook delivery we accepted, keyed by Razorpay's event id, so a retry is applied once.
create table billing_events (
  id text primary key,
  type text not null,
  user_id uuid references users(id) on delete set null,
  received_at timestamptz not null default now()
);

create table referrals (
  referred_id uuid primary key references users(id) on delete cascade,
  referrer_id uuid not null references users(id) on delete cascade,
  code text not null,
  redeemed_at timestamptz not null default now(),
  referrer_rewarded_at timestamptz
);

create table workspaces (
  id uuid primary key,
  name text not null,
  created_by uuid not null references users(id) on delete cascade,
  -- Members who opt in have their shared open items summarised in the owner/admins' brief.
  manager_brief boolean not null default false,
  created_at timestamptz not null default now()
);

create table workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null default 'member',   -- owner | admin | member
  share_with_manager boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table workspace_invites (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  email text not null,
  role text not null default 'member',
  invited_by uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  unique (workspace_id, email)
);

-- Items a member chose to share with a workspace. Nothing is shared unless listed here.
create table item_shares (
  item_id uuid not null references items(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  shared_at timestamptz not null default now(),
  primary key (item_id, workspace_id)
);

create table audit_log (
  id bigserial primary key,
  workspace_id uuid references workspaces(id) on delete cascade,
  actor_id uuid references users(id) on delete set null,
  action text not null,
  target text,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_workspace on audit_log(workspace_id, created_at);
