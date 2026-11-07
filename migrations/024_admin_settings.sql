-- Shared admin-console unlock password (hash only; changeable by allowlisted admins)
create table if not exists admin_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

alter table admin_settings enable row level security;
-- API uses service_role only; no client policies.
