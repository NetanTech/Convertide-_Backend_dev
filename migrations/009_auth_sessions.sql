-- Session management helpers.
-- auth.sessions is not exposed through PostgREST, so we wrap list/revoke in
-- security-definer RPCs callable only with the service_role key.

-- Optional device labels captured from the browser on login/refresh
-- (server-side Supabase auth calls often lose the real User-Agent).
create table if not exists user_session_devices (
  session_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  user_agent text not null default '',
  ip text not null default '',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists user_session_devices_user_id_idx
  on user_session_devices (user_id);

alter table user_session_devices enable row level security;

drop policy if exists "Users can view own session devices" on user_session_devices;
-- No client policies: only the API (service_role) reads/writes this table.

create or replace function public.list_auth_sessions(p_user_id uuid)
returns table (
  id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  refreshed_at timestamptz,
  user_agent text,
  ip text,
  aal text
)
language plpgsql
security definer
set search_path = auth, public
as $$
begin
  return query
  select
    s.id,
    s.created_at::timestamptz,
    s.updated_at::timestamptz,
    s.refreshed_at::timestamptz,
    coalesce(s.user_agent, '')::text,
    coalesce(s.ip::text, ''),
    coalesce(s.aal::text, '')
  from auth.sessions s
  where s.user_id = p_user_id
  order by coalesce(s.refreshed_at, s.updated_at, s.created_at) desc;
end;
$$;

revoke all on function public.list_auth_sessions(uuid) from public;
grant execute on function public.list_auth_sessions(uuid) to service_role;

create or replace function public.revoke_auth_session(p_user_id uuid, p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = auth, public
as $$
declare
  deleted int;
begin
  delete from auth.sessions
  where id = p_session_id
    and user_id = p_user_id;

  get diagnostics deleted = row_count;

  delete from public.user_session_devices
  where session_id = p_session_id
    and user_id = p_user_id;

  return deleted > 0;
end;
$$;

revoke all on function public.revoke_auth_session(uuid, uuid) from public;
grant execute on function public.revoke_auth_session(uuid, uuid) to service_role;
