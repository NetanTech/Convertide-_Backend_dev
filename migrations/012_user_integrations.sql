-- Per-user social publishing connections
create table if not exists user_integrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('instagram', 'facebook', 'tiktok', 'linkedin')),
  status text not null default 'connected' check (status in ('connected', 'revoked', 'error')),
  account_name text not null default '',
  account_id text not null default '',
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  scopes text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

create index if not exists user_integrations_user_id_idx on user_integrations (user_id);

alter table user_integrations enable row level security;

-- API uses service_role only; no client policies.
