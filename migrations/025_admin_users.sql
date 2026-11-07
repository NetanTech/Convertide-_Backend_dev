-- Platform admins (addable). role=superadmin reserved for later.
create table if not exists admin_users (
  email text primary key,
  role text not null default 'admin' check (role in ('admin', 'superadmin')),
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table admin_users enable row level security;
-- API uses service_role only; no client policies.

insert into admin_users (email, role)
values
  ('converttidedev@gmail.com', 'admin'),
  ('hamzatajibola401@gmail.com', 'admin'),
  ('segunabraham96@gmail.com', 'admin')
on conflict (email) do nothing;
