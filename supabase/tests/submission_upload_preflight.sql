-- Run with psql as the database owner after applying all migrations.
begin;

insert into auth.users (id) values
  ('00000000-0000-4000-8000-000000000201'),
  ('00000000-0000-4000-8000-000000000202');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000201', true);
select public.create_group('Upload preflight tenant');

reset role;
insert into public.competitions (id, group_id, name, event_type, status, max_submission_images)
select '00000000-0000-4000-8000-000000000203', id, 'Upload preflight', 'live', 'submission', 1
from public.groups where name = 'Upload preflight tenant';

set local role authenticated;
select public.join_competition('00000000-0000-4000-8000-000000000203', 'participant');
select public.save_submission('00000000-0000-4000-8000-000000000203', null, 'Photo', '{}');

do $$
declare
  competition_id uuid := '00000000-0000-4000-8000-000000000203';
  entry_id uuid;
  media_key text;
begin
  select id into entry_id from public.get_my_submission(competition_id);
  media_key := competition_id::text || '/' || entry_id::text
    || '/00000000-0000-4000-8000-000000000204.png';

  begin
    perform public.save_submission(competition_id, entry_id, 'Photo', array['one', 'two']);
    raise exception 'Submission exceeded the competition photo limit';
  exception when invalid_parameter_value then null;
  end;

  -- Match Storage's permission probe, which does not have final size metadata.
  insert into storage.objects (bucket_id, name, owner_id, metadata)
  values ('competition-submissions', media_key, auth.uid()::text,
    '{"mimetype":"image/png","contentLength":1024}');

  begin
    perform public.save_submission(competition_id, entry_id, 'Photo', array[media_key]);
    raise exception 'Incomplete upload metadata was accepted';
  exception when invalid_parameter_value then null;
  end;

  delete from storage.objects where name = media_key;
  if found is not true then
    raise exception 'Owner could not clean up an unreferenced upload';
  end if;

  begin
    insert into storage.objects (bucket_id, name, owner_id)
    values ('competition-submissions', replace(media_key, '.png', '.svg'), auth.uid()::text);
    raise exception 'Unsupported upload filename was accepted';
  exception when insufficient_privilege then null;
  end;

  insert into storage.objects (bucket_id, name, owner_id)
  values ('competition-submissions', replace(media_key, '.png', '.heic'), auth.uid()::text);
  delete from storage.objects where name = replace(media_key, '.png', '.heic');

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000202', true);
  begin
    insert into storage.objects (bucket_id, name, owner_id)
    values ('competition-submissions', media_key, auth.uid()::text);
    raise exception 'A non-owner uploaded to another entry';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000201', true);
insert into storage.objects (bucket_id, name, owner_id, metadata)
select 'competition-submissions',
  competition_id::text || '/' || id::text || '/00000000-0000-4000-8000-000000000204.png',
  creator_id::text, '{"mimetype":"image/png","size":1024}'
from public.entries where competition_id = '00000000-0000-4000-8000-000000000203';

insert into storage.objects (bucket_id, name, owner_id, metadata)
select 'competition-submissions',
  entry.competition_id::text || '/' || entry.id::text || '/' || fixture.filename,
  coalesce(fixture.owner_id, entry.creator_id::text), fixture.metadata::jsonb
from public.entries as entry
cross join (values
  ('00000000-0000-4000-8000-000000000205.png', null, '{"mimetype":"image/png","size":10485761}'),
  ('00000000-0000-4000-8000-000000000206.png', null, '{"mimetype":"image/jpeg","size":1024}'),
  ('00000000-0000-4000-8000-000000000207.png', null, '{"mimetype":"image/svg+xml","size":1024}'),
  ('00000000-0000-4000-8000-000000000208.png', '00000000-0000-4000-8000-000000000202', '{"mimetype":"image/png","size":1024}')
) as fixture(filename, owner_id, metadata)
where entry.competition_id = '00000000-0000-4000-8000-000000000203';

set local role authenticated;
do $$
declare
  competition_id uuid := '00000000-0000-4000-8000-000000000203';
  entry_id uuid;
  media_key text;
  invalid_key text;
begin
  select id into entry_id from public.get_my_submission(competition_id);
  media_key := competition_id::text || '/' || entry_id::text
    || '/00000000-0000-4000-8000-000000000204.png';

  if public.can_upload_submission_media(replace(media_key, '.png', '.webp')) is not false then
    raise exception 'Upload quota was not enforced';
  end if;
  for invalid_key in
    select name from storage.objects where name <> media_key
      and bucket_id = 'competition-submissions'
      and (storage.foldername(name))[2] = entry_id::text
  loop
    begin
      perform public.save_submission(competition_id, entry_id, 'Photo', array[invalid_key]);
      raise exception 'Invalid stored size, MIME, or ownership was accepted';
    exception when invalid_parameter_value then null;
    end;
  end loop;

  perform public.save_submission(competition_id, entry_id, 'Photo', array[media_key]);

  delete from storage.objects where name = media_key;
  if found then
    raise exception 'Referenced submission media could be deleted';
  end if;

  perform public.save_submission(competition_id, entry_id, 'Photo', '{}');
  delete from storage.objects where name = media_key;
  if found is not true then
    raise exception 'Owner could not delete a removed submission image';
  end if;
end;
$$;

reset role;
update public.competitions set submission_deadline = clock_timestamp() - interval '1 second'
where id = '00000000-0000-4000-8000-000000000203';
set local role authenticated;
do $$
begin
  if public.can_upload_submission_media(
    '00000000-0000-4000-8000-000000000203/' ||
    (select id::text from public.get_my_submission('00000000-0000-4000-8000-000000000203')) ||
    '/00000000-0000-4000-8000-000000000209.png'
  ) is not false then
    raise exception 'Uploads were allowed after the submission deadline';
  end if;
end;
$$;

rollback;
