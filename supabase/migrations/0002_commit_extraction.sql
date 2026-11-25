-- Sprint 1: atomic extraction commit, called by SupabaseStore.commitExtraction via rpc.
-- Inserts new items, closes items and marks the meeting processed in one transaction.
-- Returns false (and changes nothing) if the meeting was already processed, so two concurrent
-- runs on the same meeting cannot both write items.
create or replace function commit_extraction(
  p_meeting_id uuid,
  p_user_id uuid,
  p_new_items jsonb,   -- [{kind, text, person, quote, meeting_id, due_at}]
  p_closes jsonb,      -- [{item_id, quote}]
  p_at timestamptz
) returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_processed timestamptz;
begin
  select processed_at into v_processed
    from meetings
   where id = p_meeting_id and user_id = p_user_id
   for update;
  if not found then
    raise exception 'commit_extraction: meeting % not found for user %', p_meeting_id, p_user_id;
  end if;
  if v_processed is not null then
    return false;
  end if;

  insert into items (user_id, kind, text, person, quote, meeting_id, due_at, status, created_at)
  select p_user_id, x.kind, x.text, x.person, left(x.quote, 200),
         coalesce(x.meeting_id, p_meeting_id), x.due_at, 'open', p_at
    from jsonb_to_recordset(coalesce(p_new_items, '[]'::jsonb))
         as x(kind text, text text, person text, quote text, meeting_id uuid, due_at timestamptz);

  update items i
     set status = 'done',
         closed_by_meeting_id = p_meeting_id,
         close_quote = left(c.quote, 200),
         closed_at = p_at
    from jsonb_to_recordset(coalesce(p_closes, '[]'::jsonb)) as c(item_id uuid, quote text)
   where i.id = c.item_id
     and i.user_id = p_user_id
     and i.status = 'open';

  update meetings set processed_at = p_at where id = p_meeting_id;
  return true;
end;
$$;

revoke all on function commit_extraction(uuid, uuid, jsonb, jsonb, timestamptz) from public;
grant execute on function commit_extraction(uuid, uuid, jsonb, jsonb, timestamptz) to service_role;

-- Jobs log failures (poll, process, deliver, wispr_auth) as 'job_error' events.
-- 0001 created the check inline, so Postgres named it events_type_check.
alter table events drop constraint if exists events_type_check;
alter table events add constraint events_type_check
  check (type in ('wrong_click','done_click','undo','extract_run','brief_sent','backfill','job_error'));
