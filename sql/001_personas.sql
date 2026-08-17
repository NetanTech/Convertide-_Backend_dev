-- Run this in the Supabase SQL editor (Project -> SQL Editor -> New query).
create table if not exists public.personas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  confidence smallint not null,
  confidence_label text not null,
  confidence_summary text not null,
  demographics jsonb not null default '[]',
  psychographics jsonb not null default '[]',
  pain_points jsonb not null default '[]',
  goals jsonb not null default '[]',
  buying_triggers jsonb not null default '[]',
  objections jsonb not null default '[]',
  platform_preferences jsonb not null default '[]',
  onboarding_input jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists personas_user_id_idx on public.personas (user_id, created_at desc);

alter table public.personas enable row level security;

-- The backend talks to Supabase with the service_role key (bypasses RLS), these
-- policies only matter if the frontend ever queries Supabase directly.
create policy "Users can view their own personas" on public.personas
  for select using (auth.uid() = user_id);

create policy "Users can insert their own personas" on public.personas
  for insert with check (auth.uid() = user_id);

create policy "Users can delete their own personas" on public.personas
  for delete using (auth.uid() = user_id);
