-- Allow Email Marketing publishes (ZeptoMail) on campaign_publishes.platform.

alter table campaign_publishes
  drop constraint if exists campaign_publishes_platform_check;

alter table campaign_publishes
  add constraint campaign_publishes_platform_check
  check (platform in ('meta', 'google_ads', 'email'));
