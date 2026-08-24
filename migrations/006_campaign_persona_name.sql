-- Stores a snapshot of the persona's name at campaign-creation time, so the
-- Campaigns table can display the target persona/brand without an extra
-- join or lookup (matches the pattern plans already use with persona_snapshot).

alter table campaigns
  add column if not exists persona_name text;
