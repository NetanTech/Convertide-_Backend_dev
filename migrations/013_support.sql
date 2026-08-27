-- Help & Support: user chat tickets + messages
create table if not exists support_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subject text not null default 'Support chat',
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists support_tickets_user_id_idx on support_tickets (user_id);
create index if not exists support_tickets_user_open_idx on support_tickets (user_id, status);

create table if not exists support_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references support_tickets(id) on delete cascade,
  sender text not null check (sender in ('user', 'support')),
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists support_messages_ticket_id_idx on support_messages (ticket_id, created_at);

alter table support_tickets enable row level security;
alter table support_messages enable row level security;

-- API uses service_role only; no client policies.
