-- Core application tables. The route/service code assumed these already
-- existed, but several were never actually created in this database.
-- Every statement here is idempotent (IF NOT EXISTS / DROP+CREATE for
-- policies), so it's safe to run even against a DB where some of these
-- already exist with data in them.

-- ---------- profiles ----------
create table if not exists profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  onboarding_completed boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table profiles enable row level security;
drop policy if exists "Users can view own profile" on profiles;
create policy "Users can view own profile"
  on profiles for select
  using (auth.uid() = user_id);

-- ---------- personas ----------
create table if not exists personas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  confidence numeric not null default 0,
  confidence_label text not null default '',
  confidence_summary text not null default '',
  demographics jsonb not null default '[]',
  psychographics jsonb not null default '[]',
  pain_points jsonb not null default '[]',
  goals jsonb not null default '[]',
  buying_triggers jsonb not null default '[]',
  objections jsonb not null default '[]',
  platform_preferences jsonb not null default '[]',
  onboarding_input jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create index if not exists personas_user_id_idx on personas(user_id);
alter table personas enable row level security;
drop policy if exists "Users can view own personas" on personas;
create policy "Users can view own personas"
  on personas for select
  using (auth.uid() = user_id);

-- ---------- campaigns ----------
create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  persona_id uuid references personas(id) on delete set null,
  name text not null,
  status text not null default 'active' check (status in ('draft', 'active', 'completed')),
  duration integer,
  conversions jsonb,
  stats jsonb not null default '{}',
  tabs jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create index if not exists campaigns_user_id_idx on campaigns(user_id);
alter table campaigns enable row level security;
drop policy if exists "Users can view own campaigns" on campaigns;
create policy "Users can view own campaigns"
  on campaigns for select
  using (auth.uid() = user_id);

-- ---------- plans ----------
create table if not exists plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  persona_id uuid references personas(id) on delete set null,
  campaign_id uuid references campaigns(id) on delete set null,
  name text not null,
  status text not null default 'Draft' check (status in ('Active', 'Draft', 'Completed')),
  persona_snapshot jsonb not null default '{}',
  campaign_snapshot jsonb not null default '{}',
  budget text not null default '',
  timeline jsonb not null default '{}',
  channel_mix jsonb not null default '[]',
  weekly_action_plan jsonb not null default '[]',
  content_calendar jsonb not null default '[]',
  kpis jsonb not null default '[]',
  expected_outcome jsonb not null default '[]',
  progress integer not null default 0 check (progress between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create index if not exists plans_user_id_idx on plans(user_id);
alter table plans enable row level security;
drop policy if exists "Users can view own plans" on plans;
create policy "Users can view own plans"
  on plans for select
  using (auth.uid() = user_id);

-- ---------- assets ----------
create table if not exists assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  campaign_id uuid references campaigns(id) on delete set null,
  persona_id uuid references personas(id) on delete set null,
  type text not null check (type in ('image', 'copy', 'video')),
  title text not null,
  campaign_name text not null default '',
  persona_name text not null default '',
  platform text not null default '',
  excerpt text,
  created_at timestamptz not null default now()
);

create index if not exists assets_user_id_idx on assets(user_id);
alter table assets enable row level security;
drop policy if exists "Users can view own assets" on assets;
create policy "Users can view own assets"
  on assets for select
  using (auth.uid() = user_id);

-- ---------- notifications ----------
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null check (category in ('campaigns', 'ai', 'billing')),
  title text not null,
  description text not null default '',
  action_label text not null default '',
  action_href text not null default '',
  action_tone text not null default 'neutral' check (action_tone in ('primary', 'warning', 'insight', 'neutral')),
  unread boolean not null default true,
  dismissed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_id_idx on notifications(user_id);
alter table notifications enable row level security;
drop policy if exists "Users can view own notifications" on notifications;
create policy "Users can view own notifications"
  on notifications for select
  using (auth.uid() = user_id);

-- ---------- user_settings ----------
create table if not exists user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  persona_generated boolean not null default true,
  campaign_generated boolean not null default true,
  marketing_plan_generated boolean not null default true,
  ai_credits_low boolean not null default true,
  billing_updates boolean not null default true,
  email_notification boolean not null default false,
  content_tone text not null default '',
  content_length text not null default '',
  preferred_language text not null default '',
  auto_save_ai_results boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table user_settings enable row level security;
drop policy if exists "Users can view own settings" on user_settings;
create policy "Users can view own settings"
  on user_settings for select
  using (auth.uid() = user_id);
