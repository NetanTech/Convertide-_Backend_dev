-- Webhook replay safety, one-time fulfillment (checkout/credits), and billing audit trail.
-- Run in Supabase SQL editor after 016_plan_change_scheduling.sql.

-- Checkout / webhook invoice ids are processor strings (stripe_cs_…, paystack_…).
alter table billing_invoices
  alter column id type text using id::text;

create table if not exists billing_webhook_events (
  provider text not null check (provider in ('stripe', 'paystack')),
  event_id text not null,
  event_type text,
  status text not null default 'processing'
    check (status in ('processing', 'completed', 'failed')),
  received_at timestamptz not null default now(),
  completed_at timestamptz,
  error_message text,
  primary key (provider, event_id)
);

create index if not exists billing_webhook_events_received_at_idx
  on billing_webhook_events (received_at desc);

-- One-time side effects: plan grant, credits add-on, invoice write keyed by processor reference.
create table if not exists billing_fulfillments (
  fulfillment_key text primary key,
  user_id uuid references auth.users(id) on delete set null,
  kind text not null,
  status text not null default 'processing'
    check (status in ('processing', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists billing_fulfillments_user_id_idx
  on billing_fulfillments (user_id);

create table if not exists billing_audit_log (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete set null,
  action text not null,
  actor text not null default 'system',
  provider text,
  reference text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists billing_audit_log_user_id_idx
  on billing_audit_log (user_id, created_at desc);

create index if not exists billing_audit_log_action_idx
  on billing_audit_log (action, created_at desc);

alter table billing_webhook_events enable row level security;
alter table billing_fulfillments enable row level security;
alter table billing_audit_log enable row level security;

-- Service role (backend) bypasses RLS. No end-user policies — these are server-only.
