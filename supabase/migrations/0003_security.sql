-- Row-level security. Supabase only (uses auth.uid() and the auth schema).
--
-- The app's server connects with DATABASE_URL as the database owner, which bypasses RLS, and
-- limits every query to the signed-in user itself (HostedStore scoping). These policies are the
-- second wall: anything that reaches the tables with the public anon key or a user's JWT through
-- Supabase's REST API sees only that user's own rows. Secrets (tokens, webhooks, client
-- registrations, billing events) get no policy at all, so only the server can read them.

-- A user's row is their Supabase Auth account: deleting the account deletes everything.
alter table users add constraint users_auth_fk foreign key (id) references auth.users(id) on delete cascade;

alter table users enable row level security;
alter table connections enable row level security;
alter table oauth_clients enable row level security;
alter table meetings enable row level security;
alter table items enable row level security;
alter table briefs enable row level security;
alter table events enable row level security;
alter table looks enable row level security;
alter table marks enable row level security;
alter table caches enable row level security;
alter table prep_notified enable row level security;
alter table health enable row level security;
alter table ai_state enable row level security;
alter table subscriptions enable row level security;
alter table billing_events enable row level security;
alter table referrals enable row level security;
alter table workspaces enable row level security;
alter table workspace_members enable row level security;
alter table workspace_invites enable row level security;
alter table item_shares enable row level security;
alter table audit_log enable row level security;

-- Own rows only.
create policy users_self_read on users for select to authenticated using (id = auth.uid());
create policy users_self_update on users for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy meetings_own on meetings for select to authenticated using (user_id = auth.uid());
create policy items_own_read on items for select to authenticated using (user_id = auth.uid());
create policy items_own_write on items for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy briefs_own on briefs for select to authenticated using (user_id = auth.uid());
create policy events_own on events for select to authenticated using (user_id = auth.uid());
create policy looks_own on looks for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy marks_own on marks for select to authenticated using (user_id = auth.uid());
create policy caches_own on caches for select to authenticated using (user_id = auth.uid());
create policy health_own on health for select to authenticated using (user_id = auth.uid());
create policy ai_state_own on ai_state for select to authenticated using (user_id = auth.uid());
create policy subscriptions_own on subscriptions for select to authenticated using (user_id = auth.uid());
create policy referrals_own on referrals for select to authenticated using (referred_id = auth.uid() or referrer_id = auth.uid());
-- connections, oauth_clients, prep_notified, billing_events: no policy (server only).

-- Teams: membership checks through security-definer helpers, so policies on
-- workspace_members don't recurse into themselves.
create or replace function is_workspace_member(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from workspace_members where workspace_id = ws and user_id = auth.uid());
$$;

create or replace function is_workspace_admin(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from workspace_members where workspace_id = ws and user_id = auth.uid() and role in ('owner', 'admin'));
$$;

revoke all on function is_workspace_member(uuid) from public;
revoke all on function is_workspace_admin(uuid) from public;
grant execute on function is_workspace_member(uuid) to authenticated;
grant execute on function is_workspace_admin(uuid) to authenticated;

create policy workspaces_members on workspaces for select to authenticated using (is_workspace_member(id));
create policy members_of_my_workspaces on workspace_members for select to authenticated using (is_workspace_member(workspace_id));
create policy invites_admins on workspace_invites for select to authenticated using (is_workspace_admin(workspace_id));
create policy shares_members on item_shares for select to authenticated using (is_workspace_member(workspace_id));
create policy audit_admins on audit_log for select to authenticated using (workspace_id is not null and is_workspace_admin(workspace_id));

-- A shared item is readable by the workspace's members (and only the fields of that item).
create policy items_shared_read on items for select to authenticated
  using (exists (select 1 from item_shares s where s.item_id = items.id and is_workspace_member(s.workspace_id)));

-- The anon key gets nothing at all.
revoke all on all tables in schema public from anon;
