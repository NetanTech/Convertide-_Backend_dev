-- Opt-in weekly Meta/Email posting from plans (never enabled by generate/create).

alter table plans
  add column if not exists weekly_posting_enabled boolean not null default false,
  add column if not exists weekly_posting_platforms text[] not null default '{}',
  add column if not exists weekly_posting_hour_utc int not null default 9,
  add column if not exists weekly_posting_recipients text[] not null default '{}';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'plans_weekly_posting_hour_utc_check'
  ) then
    alter table plans
      add constraint plans_weekly_posting_hour_utc_check
      check (weekly_posting_hour_utc >= 0 and weekly_posting_hour_utc <= 23);
  end if;
end $$;

create table if not exists scheduled_publishes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid,
  plan_id uuid not null references plans(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  platform text not null check (platform in ('meta', 'email')),
  due_at timestamptz not null,
  weekday int not null check (weekday >= 0 and weekday <= 6),
  focus_label text not null default '',
  status text not null default 'pending'
    check (status in ('pending', 'publishing', 'published', 'failed', 'cancelled')),
  payload jsonb not null default '{}'::jsonb,
  publish_id uuid,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists scheduled_publishes_plan_platform_due_uidx
  on scheduled_publishes (plan_id, platform, due_at)
  where status in ('pending', 'publishing');

create index if not exists scheduled_publishes_due_pending_idx
  on scheduled_publishes (due_at)
  where status = 'pending';

create index if not exists scheduled_publishes_plan_id_idx
  on scheduled_publishes (plan_id, due_at);

alter table scheduled_publishes enable row level security;
-- API uses service_role only; no client policies.
