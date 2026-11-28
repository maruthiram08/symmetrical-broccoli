-- Fields the local app gained after 0001: where a meeting was recorded and whether it is a copy of
-- another recording, and the ticket (Jira, Linear, Notion, Todoist) made from an item.
alter table meetings add column provider text not null default 'wispr_flow';
alter table meetings add column duplicate_of text;
alter table items add column ticket jsonb;
alter table items add column close_reason text;
