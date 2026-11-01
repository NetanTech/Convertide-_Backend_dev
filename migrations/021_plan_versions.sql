-- Plan version history: snapshot before content revisions so prior plans can be restored.

create table if not exists plan_versions (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references plans(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  version_number integer not null,
  reason text not null default 'edit',
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique (plan_id, version_number)
);

create index if not exists plan_versions_plan_id_idx
  on plan_versions (plan_id, version_number desc);

alter table plan_versions enable row level security;
