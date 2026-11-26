-- Tags and projects on items, and saved views (notes and items, filter / sort / group).
-- Items keep working without them: an empty tag list and no project, as the local app.
alter table items add column tags text[] not null default '{}';
alter table items add column project text;
create index items_project on items (user_id, project) where project is not null;

-- One row per saved view. `data` is the whole view (src/lib/structure/views.ts SavedView).
create table views (
  user_id uuid not null references users(id) on delete cascade,
  id text not null,
  data jsonb not null,
  position integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
