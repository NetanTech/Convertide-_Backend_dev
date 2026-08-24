-- Adds status/duration/conversions to campaigns, which the frontend's
-- Campaign type already expects but the original table didn't store.

alter table campaigns
  add column if not exists status text not null default 'active'
    check (status in ('draft', 'active', 'completed')),
  add column if not exists duration integer,
  add column if not exists conversions jsonb;
