-- Paystack identifiers on billing accounts (replaces Stripe for Nigeria-based billing)
alter table billing_accounts
  add column if not exists paystack_customer_code text,
  add column if not exists paystack_subscription_code text,
  add column if not exists paystack_email_token text;

create unique index if not exists billing_accounts_paystack_customer_code_uidx
  on billing_accounts (paystack_customer_code)
  where paystack_customer_code is not null;

create index if not exists billing_accounts_paystack_subscription_code_idx
  on billing_accounts (paystack_subscription_code);
