-- Inbox notifications (dashboard → Notifications + topbar menu).
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  category text not null check (category in ('campaigns', 'ai', 'billing')),
  title text not null,
  description text not null,
  action_label text not null default '',
  action_href text not null default '',
  action_tone text not null default 'neutral'
    check (action_tone in ('primary', 'warning', 'insight', 'neutral')),
  unread boolean not null default true,
  dismissed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_id_idx
  on public.notifications (user_id, created_at desc);

create index if not exists notifications_user_unread_idx
  on public.notifications (user_id, unread)
  where dismissed_at is null;

alter table public.notifications enable row level security;

create policy "Users can view their own notifications" on public.notifications
  for select using (auth.uid() = user_id);

create policy "Users can update their own notifications" on public.notifications
  for update using (auth.uid() = user_id);
