-- Campaign copy packs tied to a persona.
create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  persona_id uuid references public.personas (id) on delete set null,
  name text not null,
  stats jsonb not null default '{}'::jsonb,
  tabs jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists campaigns_user_id_idx
  on public.campaigns (user_id, created_at desc);

alter table public.campaigns enable row level security;

create policy "Users can view their own campaigns" on public.campaigns
  for select using (auth.uid() = user_id);

create policy "Users can insert their own campaigns" on public.campaigns
  for insert with check (auth.uid() = user_id);

create policy "Users can update their own campaigns" on public.campaigns
  for update using (auth.uid() = user_id);

create policy "Users can delete their own campaigns" on public.campaigns
  for delete using (auth.uid() = user_id);
