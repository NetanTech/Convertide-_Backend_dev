-- Generated asset library items.
create table if not exists public.assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  campaign_id uuid references public.campaigns (id) on delete set null,
  persona_id uuid references public.personas (id) on delete set null,
  type text not null check (type in ('image', 'copy', 'video')),
  title text not null,
  campaign_name text not null default '',
  persona_name text not null default '',
  platform text not null default '',
  excerpt text,
  created_at timestamptz not null default now()
);

create index if not exists assets_user_id_idx
  on public.assets (user_id, created_at desc);

alter table public.assets enable row level security;

create policy "Users can view their own assets" on public.assets
  for select using (auth.uid() = user_id);

create policy "Users can insert their own assets" on public.assets
  for insert with check (auth.uid() = user_id);

create policy "Users can delete their own assets" on public.assets
  for delete using (auth.uid() = user_id);
