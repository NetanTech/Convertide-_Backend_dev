alter table plans
  add column if not exists progress integer not null default 0 check (progress between 0 and 100);
