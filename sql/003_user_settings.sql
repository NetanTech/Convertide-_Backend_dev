-- Run in Supabase SQL editor after 001/002.
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- Notification preferences (settings → Notifications)
  persona_generated boolean not null default true,
  campaign_generated boolean not null default true,
  marketing_plan_generated boolean not null default true,
  ai_credits_low boolean not null default true,
  billing_updates boolean not null default true,
  email_notification boolean not null default false,
  -- AI preferences (settings → AI preferences)
  content_tone text not null default '',
  content_length text not null default '',
  preferred_language text not null default '',
  auto_save_ai_results boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

create policy "Users can view their own settings" on public.user_settings
  for select using (auth.uid() = user_id);

create policy "Users can upsert their own settings" on public.user_settings
  for insert with check (auth.uid() = user_id);

create policy "Users can update their own settings" on public.user_settings
  for update using (auth.uid() = user_id);

-- Auto-create settings when a profile is created / user signs up.
create or replace function public.handle_new_user_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_settings (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_settings on auth.users;
create trigger on_auth_user_created_settings
  after insert on auth.users
  for each row execute function public.handle_new_user_settings();

insert into public.user_settings (user_id)
select id from auth.users
on conflict (user_id) do nothing;
