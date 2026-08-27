-- Fix: auth.sessions timestamps are often `timestamp` (no tz), while the
-- function declared `timestamptz` — Postgres then errors with
-- "structure of query does not match function result type".
-- Also cast aal (enum) and ip (inet) explicitly.

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
