-- Run with psql as the database owner after applying all migrations.
-- Fixtures and RPC-created data are rolled back.
begin;

insert into auth.users (id) values
  ('00000000-0000-0000-0000-000000000041'),
  ('00000000-0000-0000-0000-000000000042'),
  ('00000000-0000-0000-0000-000000000043');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
select set_config('test.group_id', public.create_group('Text submission tenant')::text, true);
select set_config(
  'test.competition_id',
  public.save_draft_competition(
    null,
    current_setting('test.group_id')::uuid,
    'Poetry competition',
    'remote',
    null,
    null,
    '[{"name":"Creativity","max_score":5}]',
    p_submission_type => 'text'
  )::text,
  true
);

reset role;
insert into public.group_members (group_id, user_id, role)
values
  (current_setting('test.group_id')::uuid, '00000000-0000-0000-0000-000000000042', 'member'),
  (current_setting('test.group_id')::uuid, '00000000-0000-0000-0000-000000000043', 'member');
update public.competitions
  set status = 'submission'
  where id = current_setting('test.competition_id')::uuid;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000042', true);
select public.join_competition(current_setting('test.competition_id')::uuid, 'participant');
select set_config(
  'test.entry_id',
  public.save_text_submission(
    current_setting('test.competition_id')::uuid,
    null,
    'First poem',
    E'  First line\nSecond line  '
  )::text,
  true
);

do $$
begin
  if not exists (
    select 1
    from public.get_my_submission(current_setting('test.competition_id')::uuid) as submission
    where submission.id = current_setting('test.entry_id')::uuid
      and submission.title = 'First poem'
      and submission.submission_text = E'First line\nSecond line'
      and cardinality(submission.media_keys) = 0
  ) then
    raise exception 'Text submitter could not read their saved entry';
  end if;

  begin
    perform public.save_submission(
      current_setting('test.competition_id')::uuid,
      null,
      'Photo on poetry night',
      '{}'
    );
    raise exception 'Photo submission was accepted in a text competition';
  exception when invalid_parameter_value then null;
  end;

  if public.can_upload_submission_media(
    current_setting('test.competition_id') || '/' ||
      current_setting('test.entry_id') || '/00000000-0000-4000-8000-000000000044.png'
  ) is not false then
    raise exception 'Storage uploads were allowed in a text competition';
  end if;

  begin
    perform public.get_admin_submissions(current_setting('test.competition_id')::uuid);
    raise exception 'A participant read the admin submission projection';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000043', true);
select public.join_competition(current_setting('test.competition_id')::uuid, 'audience');
do $$
begin
  if (select count(*) from public.get_my_submission(
        current_setting('test.competition_id')::uuid
      )) <> 0 then
    raise exception 'A different member read another participant submission';
  end if;
end;
$$;

reset role;
update public.competitions
  set status = 'voting'
  where id = current_setting('test.competition_id')::uuid;
update public.entries
  set random_number = 1
  where id = current_setting('test.entry_id')::uuid;

set local role authenticated;
do $$
begin
  if not exists (
    select 1
    from public.get_blind_voting_entries(current_setting('test.competition_id')::uuid) as entry
    where entry.entry_number = 1
      and entry.submission_text = E'First line\nSecond line'
      and cardinality(entry.media_keys) = 0
  ) then
    raise exception 'Eligible audience could not read anonymous text entry';
  end if;
  if exists (
    select 1
    from public.get_blind_voting_entries(current_setting('test.competition_id')::uuid) as entry
    where to_jsonb(entry) ? 'creator_id'
       or to_jsonb(entry) ? 'title'
       or to_jsonb(entry) ? 'id'
  ) then
    raise exception 'Blind text projection exposed identifying fields';
  end if;
end;
$$;

reset role;
update public.competitions
  set status = 'review_pending'
  where id = current_setting('test.competition_id')::uuid;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
select public.disqualify_competition_entry(
  current_setting('test.competition_id')::uuid,
  current_setting('test.entry_id')::uuid,
  'Inappropriate text',
  'remove_content'
);
do $$
begin
  if not exists (
    select 1
    from public.get_admin_submissions(current_setting('test.competition_id')::uuid) as submission
    where submission.id = current_setting('test.entry_id')::uuid
      and submission.title = 'Content removed'
      and submission.submission_text is null
  ) then
    raise exception 'Content-removal moderation did not clear submitted text';
  end if;
end;
$$;

rollback;
