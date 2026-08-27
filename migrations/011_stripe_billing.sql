-- Stripe identifiers on billing accounts
alter table billing_accounts
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text;

create unique index if not exists billing_accounts_stripe_customer_id_uidx
  on billing_accounts (stripe_customer_id)
  where stripe_customer_id is not null;

create index if not exists billing_accounts_stripe_subscription_id_idx
  on billing_accounts (stripe_subscription_id);
