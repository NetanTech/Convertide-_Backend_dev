-- Idempotent campaign generate/publish + auditable publish records (AC-008 safety).

create table if not exists request_idempotency (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid,
  scope text not null,
  request_key text not null,
  status text not null default 'processing'
    check (status in ('processing', 'completed', 'failed')),
  resource_id uuid,
  response jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (user_id, scope, request_key)
);

create index if not exists request_idempotency_resource_idx
  on request_idempotency (resource_id);

create table if not exists campaign_publishes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  platform text not null check (platform in ('meta', 'google_ads')),
  status text not null default 'previewed'
    check (status in ('previewed', 'publishing', 'published', 'failed', 'revoked')),
  account_provider text,
  account_name text,
  external_id text,
  preview jsonb not null default '{}'::jsonb,
  idempotency_key text,
  error_message text,
  published_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists campaign_publishes_idempotency_uidx
  on campaign_publishes (user_id, campaign_id, platform, idempotency_key)
  where idempotency_key is not null;

create index if not exists campaign_publishes_campaign_id_idx
  on campaign_publishes (campaign_id, created_at desc);

alter table request_idempotency enable row level security;
alter table campaign_publishes enable row level security;
