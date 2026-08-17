-- Marketing plans tied to a persona + optional campaign.
create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  persona_id uuid references public.personas (id) on delete set null,
  campaign_id uuid references public.campaigns (id) on delete set null,
  name text not null,
  status text not null default 'Draft' check (status in ('Active', 'Draft', 'Completed')),
  persona_snapshot jsonb not null default '{}'::jsonb,
  campaign_snapshot jsonb not null default '{}'::jsonb,
  budget text not null default '',
  timeline jsonb not null default '{}'::jsonb,
  channel_mix jsonb not null default '[]'::jsonb,
  weekly_action_plan jsonb not null default '[]'::jsonb,
  content_calendar jsonb not null default '[]'::jsonb,
  kpis jsonb not null default '[]'::jsonb,
  expected_outcome jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists plans_user_id_idx
  on public.plans (user_id, created_at desc);

alter table public.plans enable row level security;

create policy "Users can view their own plans" on public.plans
  for select using (auth.uid() = user_id);

create policy "Users can insert their own plans" on public.plans
  for insert with check (auth.uid() = user_id);

create policy "Users can update their own plans" on public.plans
  for update using (auth.uid() = user_id);

create policy "Users can delete their own plans" on public.plans
  for delete using (auth.uid() = user_id);
