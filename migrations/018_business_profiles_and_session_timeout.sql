-- Multi-business profiles (OB-003) + configurable idle timeout (UM-004).
-- Also account_audit_log for unauthorized / concurrent-sensitive actions (AC5).

-- ---------- session preference ----------
alter table user_settings
  add column if not exists session_timeout_minutes integer not null default 15
    check (session_timeout_minutes between 5 and 120);

-- ---------- business profiles ----------
create table if not exists business_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  industry text not null default '',
  is_default boolean not null default false,
  credits_used integer not null default 0,
  credits_total integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists business_profiles_user_id_idx on business_profiles (user_id);

create unique index if not exists business_profiles_one_default_per_user_uidx
  on business_profiles (user_id)
  where is_default = true;

alter table profiles
  add column if not exists active_business_id uuid references business_profiles(id) on delete set null;

-- Scope content to a business. Nullable briefly for backfill, then required for new rows.
alter table personas add column if not exists business_id uuid references business_profiles(id) on delete cascade;
alter table campaigns add column if not exists business_id uuid references business_profiles(id) on delete cascade;
alter table plans add column if not exists business_id uuid references business_profiles(id) on delete cascade;
alter table assets add column if not exists business_id uuid references business_profiles(id) on delete cascade;

create index if not exists personas_business_id_idx on personas (business_id);
create index if not exists campaigns_business_id_idx on campaigns (business_id);
create index if not exists plans_business_id_idx on plans (business_id);
create index if not exists assets_business_id_idx on assets (business_id);

-- Backfill: one default business per user that already has content or a profile.
insert into business_profiles (user_id, name, industry, is_default)
select distinct p.user_id, 'My business', '', true
from profiles p
where not exists (
  select 1 from business_profiles b where b.user_id = p.user_id
)
on conflict do nothing;

insert into business_profiles (user_id, name, industry, is_default)
select distinct x.user_id, 'My business', '', true
from (
  select user_id from personas
  union
  select user_id from campaigns
  union
  select user_id from plans
  union
  select user_id from assets
) x
where not exists (
  select 1 from business_profiles b where b.user_id = x.user_id
)
on conflict do nothing;

update personas pe
set business_id = b.id
from business_profiles b
where pe.user_id = b.user_id and b.is_default = true and pe.business_id is null;

update campaigns c
set business_id = b.id
from business_profiles b
where c.user_id = b.user_id and b.is_default = true and c.business_id is null;

update plans pl
set business_id = b.id
from business_profiles b
where pl.user_id = b.user_id and b.is_default = true and pl.business_id is null;

update assets a
set business_id = b.id
from business_profiles b
where a.user_id = b.user_id and b.is_default = true and a.business_id is null;

update profiles p
set active_business_id = b.id
from business_profiles b
where p.user_id = b.user_id and b.is_default = true and p.active_business_id is null;

-- ---------- account audit (auth / business / security) ----------
create table if not exists account_audit_log (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete set null,
  action text not null,
  actor text not null default 'system',
  business_id uuid,
  reference text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists account_audit_log_user_id_idx
  on account_audit_log (user_id, created_at desc);

alter table business_profiles enable row level security;
alter table account_audit_log enable row level security;
