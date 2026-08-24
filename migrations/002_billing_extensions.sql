-- Extends billing_accounts with subscription tier, usage, and address fields,
-- and adds a payment_methods table. Run this in the Supabase SQL editor.

alter table billing_accounts
  add column if not exists plan_id text not null default 'pro',
  add column if not exists billing_cycle text not null default 'Billed monthly',
  add column if not exists seats_used integer not null default 1,
  add column if not exists seats_limit integer not null default 5,
  add column if not exists projects text not null default 'Unlimited',
  add column if not exists api_priority text not null default 'Standard',
  add column if not exists billing_company text,
  add column if not exists billing_line1 text,
  add column if not exists billing_line2 text,
  add column if not exists billing_city text,
  add column if not exists billing_state text,
  add column if not exists billing_postal_code text,
  add column if not exists billing_country text,
  add column if not exists updated_at timestamptz not null default now();

create table if not exists payment_methods (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  brand text not null check (brand in ('visa', 'mastercard')),
  last4 text not null,
  expiry text not null,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists payment_methods_user_id_idx on payment_methods(user_id);

alter table payment_methods enable row level security;

-- Service role (used by the backend) bypasses RLS automatically, so these
-- policies just make sure nothing else can read/write other users' rows
-- if you ever expose this table via anon/authenticated keys.
drop policy if exists "Users can view own payment methods" on payment_methods;
create policy "Users can view own payment methods"
  on payment_methods for select
  using (auth.uid() = user_id);
