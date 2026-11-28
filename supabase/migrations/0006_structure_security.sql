-- Row-level security for saved views (Supabase only, like 0003_security.sql).
alter table views enable row level security;
create policy views_own on views for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
