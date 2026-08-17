-- Optional: track persona edits.
alter table public.personas
  add column if not exists updated_at timestamptz;

update public.personas
set updated_at = created_at
where updated_at is null;
