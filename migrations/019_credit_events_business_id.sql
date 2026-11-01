-- Scope credit ledger rows to a business profile when known (OB-003 quotas/history).
alter table billing_credit_events
  add column if not exists business_id uuid references business_profiles(id) on delete set null;

create index if not exists billing_credit_events_business_id_idx
  on billing_credit_events (business_id, created_at desc);
