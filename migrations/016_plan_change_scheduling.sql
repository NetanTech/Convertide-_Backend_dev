-- A downgrade takes effect only once the period the user already paid for ends, so the
-- next tier has to be remembered until then.
alter table public.billing_accounts
  add column if not exists pending_plan_id text,
  add column if not exists pending_plan_starts_on timestamptz;
