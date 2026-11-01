-- Persona version history: snapshot before edit/regenerate so older states can be restored.

create table if not exists persona_versions (
  id uuid primary key default gen_random_uuid(),
  persona_id uuid not null references personas(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  version_number integer not null,
  reason text not null default 'edit',
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique (persona_id, version_number)
);

create index if not exists persona_versions_persona_id_idx
  on persona_versions (persona_id, version_number desc);

alter table persona_versions enable row level security;
