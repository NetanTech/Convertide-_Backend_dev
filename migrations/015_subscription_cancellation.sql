-- Cancelling a paid plan stops the renewal but keeps access until the paid period
-- ends. `renews_on` doubles as the access-until date while this flag is set.
alter table public.billing_accounts
  add column if not exists cancel_at_period_end boolean not null default false;
