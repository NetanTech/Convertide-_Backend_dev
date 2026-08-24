-- Base billing tables. These were assumed to already exist (the original
-- billing routes queried them) but were never actually provisioned — run
-- this before 002_billing_extensions.sql.

create table if not exists billing_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan_name text not null default 'Pro',
  plan_price text not null default '$149',
  plan_cycle text default 'mo',
  renews_on timestamptz,
  credits_used integer not null default 0,
  credits_total integer,
  payment_brand text,
  payment_last4 text,
  payment_expiry text,
  created_at timestamptz not null default now()
);

alter table billing_accounts enable row level security;

drop policy if exists "Users can view own billing account" on billing_accounts;
create policy "Users can view own billing account"
  on billing_accounts for select
  using (auth.uid() = user_id);

create table if not exists billing_invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  invoice_date timestamptz not null default now(),
  description text not null,
  amount text not null,
  status text not null default 'paid' check (status in ('paid', 'pending', 'failed')),
  created_at timestamptz not null default now()
);

create index if not exists billing_invoices_user_id_idx on billing_invoices(user_id);

alter table billing_invoices enable row level security;

drop policy if exists "Users can view own invoices" on billing_invoices;
create policy "Users can view own invoices"
  on billing_invoices for select
  using (auth.uid() = user_id);
