-- Public bucket for uploaded marketing assets (images, videos, PDFs, copy files).
insert into storage.buckets (id, name, public)
values ('assets', 'assets', true)
on conflict (id) do nothing;

drop policy if exists "Authenticated users can upload assets" on storage.objects;
create policy "Authenticated users can upload assets"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'assets' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Public read assets" on storage.objects;
create policy "Public read assets"
  on storage.objects for select
  to public
  using (bucket_id = 'assets');

drop policy if exists "Users can delete own assets" on storage.objects;
create policy "Users can delete own assets"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'assets' and (storage.foldername(name))[1] = auth.uid()::text);
