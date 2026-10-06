-- Run with psql as the database owner after applying all migrations.
-- Fixtures and RPC-created data are rolled back.
begin;

insert into auth.users (id) values
  ('00000000-0000-0000-0000-000000000021'),
  ('00000000-0000-0000-0000-000000000022'),
  ('00000000-0000-0000-0000-000000000023');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000021', true);
select public.create_group('Submission access tenant');

reset role;
insert into public.group_members (group_id, user_id, role)
select id, '00000000-0000-0000-0000-000000000022', 'member'
from public.groups where name = 'Submission access tenant';
insert into public.competitions (
  id, group_id, name, event_type, status, submission_deadline, voting_deadline
)
select
  '00000000-0000-0000-0000-000000000024',
  id,
  'Submission challenge',
  'remote',
  'submission',
  clock_timestamp() + interval '1 hour',
  clock_timestamp() + interval '2 hours'
from public.groups where name = 'Submission access tenant';

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000022', true);
select public.save_submission(
  '00000000-0000-0000-0000-000000000024', null, 'Private title', '{}'
);
select public.save_submission(
  '00000000-0000-0000-0000-000000000024',
  (select id from public.get_my_submission('00000000-0000-0000-0000-000000000024')),
  'Edited private title',
  '{}'
);

do $$
declare
  v_competition_id uuid := '00000000-0000-0000-0000-000000000024';
  v_entry_id uuid;
begin
  select submission.id into v_entry_id
  from public.get_my_submission(v_competition_id) as submission;

  if v_entry_id is null
     or (select title from public.get_my_submission(v_competition_id)) <> 'Edited private title' then
    raise exception 'Member could not edit or read their own submission';
  end if;

  if public.can_upload_submission_media(
    v_competition_id::text || '/' || v_entry_id::text ||
      '/00000000-0000-4000-8000-000000000025.png',
    'image/png',
    1024
  ) is not true then
    raise exception 'Submission owner could not upload valid private media';
  end if;
  if public.can_upload_submission_media(
    v_competition_id::text || '/' || v_entry_id::text ||
      '/00000000-0000-4000-8000-000000000027.heic',
    'image/heic',
    1024
  ) is not true
     or public.can_upload_submission_media(
       v_competition_id::text || '/' || v_entry_id::text ||
         '/00000000-0000-4000-8000-000000000028.heif',
       'image/heif',
       1024
     ) is not true then
    raise exception 'Submission owner could not upload HEIC/HEIF media';
  end if;
  if public.can_read_submission_media(
    v_competition_id::text || '/' || v_entry_id::text ||
      '/00000000-0000-4000-8000-000000000025.png'
  ) is not true then
    raise exception 'Submission owner could not read private media';
  end if;
  if public.can_delete_submission_media(
    v_competition_id::text || '/' || v_entry_id::text ||
      '/00000000-0000-4000-8000-000000000025.png'
  ) is not true then
    raise exception 'Submission owner could not clean up unreferenced media';
  end if;

  if public.can_upload_submission_media(
    v_competition_id::text || '/' || v_entry_id::text ||
      '/original-user-name.png',
    'image/png',
    1024
  ) is not false
     or public.can_upload_submission_media(
       v_competition_id::text || '/' || v_entry_id::text ||
         '/00000000-0000-4000-8000-000000000025.svg',
       'image/svg+xml',
       1024
     ) is not false
     or public.can_upload_submission_media(
       v_competition_id::text || '/' || v_entry_id::text ||
         '/00000000-0000-4000-8000-000000000025.png',
       'image/jpeg',
       1024
     ) is not false
     or public.can_upload_submission_media(
       v_competition_id::text || '/' || v_entry_id::text ||
         '/00000000-0000-4000-8000-000000000025.png',
       'image/png',
       10485761
     ) is not false
     or public.can_upload_submission_media(
       v_competition_id::text || '/' || v_entry_id::text ||
         '/00000000-0000-4000-8000-000000000029.heic',
       'image/heif',
       1024
     ) is not false then
    raise exception 'Invalid media names, types, or sizes were accepted';
  end if;

  begin
    perform public.get_admin_submissions(v_competition_id);
    raise exception 'A member read the admin submission projection';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.entries (competition_id, creator_id, title)
    values (v_competition_id, auth.uid(), 'Direct write');
    raise exception 'Direct entry writes were allowed';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000021', true);
set local role authenticated;
do $$
begin
  if (select count(*) from public.get_admin_submissions(
    '00000000-0000-0000-0000-000000000024'
  )) <> 1 then
    raise exception 'Admin could not read the admin submission projection';
  end if;
  if public.can_read_submission_media(
    '00000000-0000-0000-0000-000000000024/' ||
      (select id::text from public.get_admin_submissions(
        '00000000-0000-0000-0000-000000000024'
      )) || '/00000000-0000-4000-8000-000000000025.png'
  ) is not true then
    raise exception 'Admin could not read private media';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000023', true);
set local role authenticated;
do $$
begin
  begin
    perform public.save_submission(
      '00000000-0000-0000-0000-000000000024', null, 'Unauthorized', '{}'
    );
    raise exception 'A non-member submitted an entry';
  exception when insufficient_privilege then null;
  end;
  if public.can_read_submission_media(
    '00000000-0000-0000-0000-000000000024/' ||
      '00000000-0000-0000-0000-000000000026/' ||
      '00000000-0000-4000-8000-000000000025.png'
  ) is not false then
    raise exception 'A non-member could read private media';
  end if;
end;
$$;

reset role;
update public.competitions
  set submission_deadline = clock_timestamp() - interval '1 second'
  where id = '00000000-0000-0000-0000-000000000024';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000022', true);
do $$
begin
  begin
    perform public.save_submission(
      '00000000-0000-0000-0000-000000000024', null, 'Late entry', '{}'
    );
    raise exception 'Submission after the deadline was accepted';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

reset role;
update public.competitions
  set status = 'voting',
      voting_deadline = clock_timestamp() + interval '1 hour'
  where id = '00000000-0000-0000-0000-000000000024';
set local role authenticated;
do $$
begin
  if (select count(*) from public.get_blind_voting_entries(
    '00000000-0000-0000-0000-000000000024'
  )) <> 0 then
    raise exception 'A voter was shown their own entry in the blind projection';
  end if;
  if exists (
    select 1
    from public.get_blind_voting_entries(
      '00000000-0000-0000-0000-000000000024'
    ) as entry
    where to_jsonb(entry) ? 'creator_id'
       or to_jsonb(entry) ? 'title'
       or to_jsonb(entry) ? 'id'
  ) then
    raise exception 'Blind voting projection exposed identifying fields';
  end if;
  if public.can_read_submission_media(
    '00000000-0000-0000-0000-000000000024/' ||
      (select id::text from public.get_my_submission(
        '00000000-0000-0000-0000-000000000024'
      )) || '/00000000-0000-4000-8000-000000000025.png'
  ) is not false then
    raise exception 'Blind voting exposed an unreferenced media upload';
  end if;
  begin
    perform public.save_submission(
      '00000000-0000-0000-0000-000000000024', null, 'Too late to edit', '{}'
    );
    raise exception 'Entry edit was allowed after submissions closed';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

reset role;
update public.competitions
  set voting_deadline = clock_timestamp() - interval '1 second'
  where id = '00000000-0000-0000-0000-000000000024';
set local role authenticated;
do $$
begin
  begin
    perform public.get_blind_voting_entries(
      '00000000-0000-0000-0000-000000000024'
    );
    raise exception 'Blind voting remained available after its deadline';
  exception when insufficient_privilege then null;
  end;
  if public.can_read_submission_media(
    '00000000-0000-0000-0000-000000000024/' ||
      (select id::text from public.get_my_submission(
        '00000000-0000-0000-0000-000000000024'
      )) || '/00000000-0000-4000-8000-000000000025.png'
  ) is not false then
    raise exception 'Blind-voting media remained readable after its deadline';
  end if;
end;
$$;

rollback;
