-- Billing snapshot + invoice history (Stripe can replace this later).
create table if not exists public.billing_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan_name text not null default 'Starter Plan',
  plan_price text not null default '$19',
  plan_cycle text not null default 'month',
  renews_on timestamptz,
  credits_used integer not null default 0,
  credits_total integer not null default 2000,
  payment_brand text,
  payment_last4 text,
  payment_expiry text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_invoices (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  invoice_date timestamptz not null default now(),
  description text not null,
  amount text not null,
  status text not null check (status in ('paid', 'pending', 'failed')),
  created_at timestamptz not null default now()
);

create index if not exists billing_invoices_user_id_idx
  on public.billing_invoices (user_id, invoice_date desc);

alter table public.billing_accounts enable row level security;
alter table public.billing_invoices enable row level security;

create policy "Users can view their own billing account" on public.billing_accounts
  for select using (auth.uid() = user_id);

create policy "Users can view their own invoices" on public.billing_invoices
  for select using (auth.uid() = user_id);

-- Provision a starter billing account for every new user.
create or replace function public.handle_new_user_billing()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.billing_accounts (user_id, renews_on)
  values (new.id, now() + interval '30 days')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_billing on auth.users;
create trigger on_auth_user_created_billing
  after insert on auth.users
  for each row execute function public.handle_new_user_billing();

insert into public.billing_accounts (user_id, renews_on)
select id, now() + interval '30 days' from auth.users
on conflict (user_id) do nothing;
