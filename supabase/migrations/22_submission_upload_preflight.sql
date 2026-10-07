begin;

-- Storage checks INSERT permission before uploading, when metadata.size is
-- unavailable. Authorize the destination here; the bucket enforces upload
-- size/type limits and save_submission validates the completed object's metadata.
create or replace function public.can_upload_submission_media(p_name text)
returns boolean
language sql
set search_path = ''
as $$
  select public.can_upload_submission_media(
    p_name,
    case storage.extension(p_name)
      when 'jpg' then 'image/jpeg'
      when 'png' then 'image/png'
      when 'webp' then 'image/webp'
      when 'heic' then 'image/heic'
      when 'heif' then 'image/heif'
      else 'application/octet-stream'
    end,
    1::bigint
  );
$$;

revoke all on function public.can_upload_submission_media(text) from public, anon, authenticated;
grant execute on function public.can_upload_submission_media(text) to authenticated;

drop policy "Submission media upload" on storage.objects;
create policy "Submission media upload"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'competition-submissions'
  and public.can_upload_submission_media(name)
);

commit;
