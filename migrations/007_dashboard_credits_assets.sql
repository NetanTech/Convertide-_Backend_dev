-- Credit ledger for usage chart + spend tracking, asset file URLs, pdf type.

create table if not exists public.billing_credit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  amount integer not null check (amount > 0),
  reason text not null,
  created_at timestamptz not null default now()
);

create index if not exists billing_credit_events_user_created_idx
  on public.billing_credit_events (user_id, created_at desc);

alter table public.billing_credit_events enable row level security;

drop policy if exists "Users can view own credit events" on public.billing_credit_events;
create policy "Users can view own credit events"
  on public.billing_credit_events for select
  using (auth.uid() = user_id);

-- Allow PDF assets and optional file URLs for uploads.
alter table public.assets drop constraint if exists assets_type_check;
alter table public.assets
  add constraint assets_type_check check (type in ('image', 'copy', 'video', 'pdf'));

alter table public.assets
  add column if not exists file_url text;
