-- Run with psql as the database owner after applying all migrations.
-- Fixtures, ballots and membership changes are rolled back.
begin;

insert into auth.users (id)
select ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid
from generate_series(701, 707) as n;
insert into public.groups (id, name, created_by) values
  ('00000000-0000-0000-0000-000000000711', 'Participant voting tenant', '00000000-0000-0000-0000-000000000701'),
  ('00000000-0000-0000-0000-000000000712', 'Other voting tenant', '00000000-0000-0000-0000-000000000707');
insert into public.group_members (group_id, user_id, role)
select '00000000-0000-0000-0000-000000000711',
  ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  case when n = 701 then 'admin' else 'member' end
from generate_series(701, 706) as n;
insert into public.group_members (group_id, user_id, role) values
  ('00000000-0000-0000-0000-000000000712', '00000000-0000-0000-0000-000000000707', 'admin');

insert into public.competitions (id, group_id, name, event_type, status) values
  ('00000000-0000-0000-0000-000000000721', '00000000-0000-0000-0000-000000000711', 'Voting default off', 'live', 'voting'),
  ('00000000-0000-0000-0000-000000000722', '00000000-0000-0000-0000-000000000711', 'Voting enabled', 'live', 'voting');
update public.competitions set allow_participant_voting = true
where id = '00000000-0000-0000-0000-000000000722';
insert into public.categories (id, competition_id, name, max_score) values
  ('00000000-0000-0000-0000-000000000731', '00000000-0000-0000-0000-000000000721', 'Quality', 5),
  ('00000000-0000-0000-0000-000000000732', '00000000-0000-0000-0000-000000000722', 'Quality', 5),
  ('00000000-0000-0000-0000-000000000733', '00000000-0000-0000-0000-000000000722', 'Style', 3);
insert into public.competition_participants (competition_id, user_id, role)
select competition.id, ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  case when n = 704 then 'audience' else 'participant' end
from public.competitions as competition
cross join generate_series(702, 706) as n
where competition.id in ('00000000-0000-0000-0000-000000000721', '00000000-0000-0000-0000-000000000722')
  and n <> 705; -- A group member who has not joined.
insert into public.entries (id, competition_id, creator_id, title, random_number, is_disqualified) values
  ('00000000-0000-0000-0000-000000000741', '00000000-0000-0000-0000-000000000721', '00000000-0000-0000-0000-000000000703', 'Default entry', 1, false),
  ('00000000-0000-0000-0000-000000000742', '00000000-0000-0000-0000-000000000722', '00000000-0000-0000-0000-000000000702', 'Own entry', 1, false),
  ('00000000-0000-0000-0000-000000000743', '00000000-0000-0000-0000-000000000722', '00000000-0000-0000-0000-000000000703', 'Other entry', 2, false),
  ('00000000-0000-0000-0000-000000000744', '00000000-0000-0000-0000-000000000722', '00000000-0000-0000-0000-000000000706', 'Disqualified entry', 3, true);
update public.entries set media_keys = array[
  competition_id::text || '/' || id::text || '/00000000-0000-4000-8000-000000000751.jpg'
] where id in (
  '00000000-0000-0000-0000-000000000741', '00000000-0000-0000-0000-000000000742',
  '00000000-0000-0000-0000-000000000743', '00000000-0000-0000-0000-000000000744'
);
insert into storage.objects (bucket_id, name, owner_id, metadata)
select 'competition-submissions', media_keys[1], creator_id::text,
  '{"mimetype":"image/jpeg","size":100}'::jsonb
from public.entries where id in (
  '00000000-0000-0000-0000-000000000741', '00000000-0000-0000-0000-000000000742',
  '00000000-0000-0000-0000-000000000743', '00000000-0000-0000-0000-000000000744'
);
select set_config('test.voting_scores', '[
  {"category_id":"00000000-0000-0000-0000-000000000732","score":4},
  {"category_id":"00000000-0000-0000-0000-000000000733","score":2}
]', true);
select set_config('test.voting_media',
  '00000000-0000-0000-0000-000000000722/00000000-0000-0000-0000-000000000743/00000000-0000-4000-8000-000000000751.jpg', true);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000701', true);
do $$
declare
  draft_id uuid;
  legacy_id uuid;
  flag boolean;
begin
  legacy_id := public.save_draft_competition(null, '00000000-0000-0000-0000-000000000711',
    'Legacy draft', 'live', null, null, '[{"name":"Quality","max_score":5}]');
  if (select allow_participant_voting from public.competitions where id = legacy_id) then
    raise exception 'Omitted setting must default to false';
  end if;
  draft_id := public.save_draft_competition(null, '00000000-0000-0000-0000-000000000711',
    'Enabled draft', 'live', null, null, '[{"name":"Quality","max_score":5}]',
    ' Description ', ' Rules ', true);
  perform set_config('test.voting_draft', draft_id::text, true);
  foreach flag in array array[true, false, true] loop
    perform public.save_draft_competition(draft_id, '00000000-0000-0000-0000-000000000711',
      'Enabled draft', 'live', null, null, '[{"name":"Quality","max_score":5}]', null, null, flag);
    -- Both legacy signatures and explicit null preserve the setting.
    perform public.save_draft_competition(draft_id, '00000000-0000-0000-0000-000000000711',
      'Enabled draft', 'live', null, null, '[{"name":"Quality","max_score":5}]');
    perform public.save_draft_competition(draft_id, '00000000-0000-0000-0000-000000000711',
      'Enabled draft', 'live', null, null, '[{"name":"Quality","max_score":5}]', 'Description', 'Rules');
    perform public.save_draft_competition(draft_id, '00000000-0000-0000-0000-000000000711',
      'Enabled draft', 'live', null, null, '[{"name":"Quality","max_score":5}]', 'Description', 'Rules', null);
    if (select allow_participant_voting from public.competitions where id = draft_id) is distinct from flag then
      raise exception 'Draft flag edit or legacy omission failed';
    end if;
  end loop;
  begin
    perform public.save_draft_competition(draft_id, '00000000-0000-0000-0000-000000000712',
      'Wrong tenant', 'live', null, null, '[{"name":"Quality","max_score":5}]', null, null, false);
    raise exception 'Draft tenant move accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.competitions set allow_participant_voting = false where id = draft_id;
    raise exception 'Direct flag update allowed';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000702', true);
do $$
begin
  begin
    perform public.save_ballot('00000000-0000-0000-0000-000000000721', 1,
      '[{"category_id":"00000000-0000-0000-0000-000000000731","score":4}]');
    raise exception 'Participant voted with default off';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_blind_voting_entries('00000000-0000-0000-0000-000000000721');
    raise exception 'Participant browsed with default off';
  exception when insufficient_privilege then null;
  end;
  if exists (select 1 from storage.objects where name like '00000000-0000-0000-0000-000000000721/%') then
    raise exception 'Participant accessed media with default off';
  end if;
  if (select array_agg(entry_number) from public.get_blind_voting_entries(
      '00000000-0000-0000-0000-000000000722')) is distinct from array[2::bigint] then
    raise exception 'Blind entries must exclude own and disqualified entries';
  end if;
  if not public.can_read_submission_media(current_setting('test.voting_media'))
     or (select count(*) from storage.objects where name like '00000000-0000-0000-0000-000000000722/%') <> 1 then
    raise exception 'Voting media read policy did not match blind eligibility';
  end if;
  perform public.save_ballot('00000000-0000-0000-0000-000000000722', 2, current_setting('test.voting_scores')::jsonb);
  perform public.save_ballot('00000000-0000-0000-0000-000000000722', 2,
    '[{"category_id":"00000000-0000-0000-0000-000000000732","score":5},
      {"category_id":"00000000-0000-0000-0000-000000000733","score":3}]');
  begin
    perform public.save_ballot('00000000-0000-0000-0000-000000000722', 1, current_setting('test.voting_scores')::jsonb);
    raise exception 'Self-voting accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.save_ballot('00000000-0000-0000-0000-000000000722', 3, current_setting('test.voting_scores')::jsonb);
    raise exception 'Disqualified entry accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform 1 from public.entries;
    raise exception 'Direct entry reads allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.votes (entry_id, voter_id, category_id, score) values
      ('00000000-0000-0000-0000-000000000743', auth.uid(), '00000000-0000-0000-0000-000000000732', 1);
    raise exception 'Direct vote writes allowed';
  exception when insufficient_privilege then null;
  end;
end;
$$;

-- Rejected revisions must leave every category of the existing ballot untouched.
do $$
declare
  invalid_scores jsonb;
begin
  for invalid_scores in select value from jsonb_array_elements('[
    null, {}, [],
    [{"category_id":"00000000-0000-0000-0000-000000000732","score":1}],
    [{"category_id":"00000000-0000-0000-0000-000000000732","score":1},{"category_id":"00000000-0000-0000-0000-000000000733","score":4}],
    [{"category_id":"00000000-0000-0000-0000-000000000732","score":1},{"category_id":"00000000-0000-0000-0000-000000000732","score":2}],
    [{"category_id":"00000000-0000-0000-0000-000000000732","score":1},{"category_id":"00000000-0000-0000-0000-000000000731","score":2}],
    [{"category_id":"bad","score":1},{"category_id":"00000000-0000-0000-0000-000000000733","score":2}]
  ]'::jsonb) loop
    begin
      perform public.save_ballot('00000000-0000-0000-0000-000000000722', 2, invalid_scores);
      raise exception 'Invalid ballot accepted: %', invalid_scores;
    exception when invalid_parameter_value then null;
    end;
  end loop;
end;
$$;
reset role;
do $$
begin
  if (select count(*) from public.votes) <> 2
     or not exists (select 1 from public.votes where category_id = '00000000-0000-0000-0000-000000000732' and score = 5)
     or not exists (select 1 from public.votes where category_id = '00000000-0000-0000-0000-000000000733' and score = 3) then
    raise exception 'Ballot revision or atomic validation failed';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000704', true);
do $$
begin
  perform public.save_ballot('00000000-0000-0000-0000-000000000721', 1,
    '[{"category_id":"00000000-0000-0000-0000-000000000731","score":4}]');
  perform public.save_ballot('00000000-0000-0000-0000-000000000722', 2, current_setting('test.voting_scores')::jsonb);
  if (select count(*) from public.get_blind_voting_entries('00000000-0000-0000-0000-000000000721')) <> 1
     or (select count(*) from public.get_blind_voting_entries('00000000-0000-0000-0000-000000000722')) <> 2
     or (select count(*) from storage.objects) <> 3 then
    raise exception 'Audience access changed with flag off/on';
  end if;
end;
$$;
reset role;

-- An explicitly disabled setting has the same denial behavior as the default.
update public.competitions set allow_participant_voting = false
where id = '00000000-0000-0000-0000-000000000722';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000702', true);
do $$
begin
  begin
    perform public.save_ballot('00000000-0000-0000-0000-000000000722', 2, current_setting('test.voting_scores')::jsonb);
    raise exception 'Participant revised ballot with setting explicitly off';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_blind_voting_entries('00000000-0000-0000-0000-000000000722');
    raise exception 'Participant browsed with setting explicitly off';
  exception when insufficient_privilege then null;
  end;
  if public.can_read_submission_media(current_setting('test.voting_media'))
     or exists (select 1 from storage.objects where name = current_setting('test.voting_media')) then
    raise exception 'Participant read media with setting explicitly off';
  end if;
end;
$$;
reset role;
update public.competitions set allow_participant_voting = true,
  voting_deadline = clock_timestamp() + interval '1 hour'
where id = '00000000-0000-0000-0000-000000000722';
set local role authenticated;
do $$
begin
  perform public.save_ballot('00000000-0000-0000-0000-000000000722', 2, current_setting('test.voting_scores')::jsonb);
  if (select count(*) from public.get_blind_voting_entries('00000000-0000-0000-0000-000000000722')) <> 1
     or not public.can_read_submission_media(current_setting('test.voting_media')) then
    raise exception 'Future voting deadline should permit participating voters';
  end if;
  if public.can_read_submission_media(
    replace(current_setting('test.voting_media'), '00000000-0000-4000-8000-000000000751.jpg',
      '00000000-0000-4000-8000-000000000752.jpg')) then
    raise exception 'Unattached media key accessible through blind voting';
  end if;
end;
$$;
reset role;

-- Freeze the flag in every non-draft phase, even through old-client calls.
do $$
declare
  phase text;
begin
  foreach phase in array array['submission', 'voting', 'review_pending', 'results_published'] loop
    update public.competitions set status = phase where id = current_setting('test.voting_draft')::uuid;
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000701', true);
    begin
      perform public.save_draft_competition(current_setting('test.voting_draft')::uuid,
        '00000000-0000-0000-0000-000000000711', 'Frozen', 'live', null, null,
        '[{"name":"Quality","max_score":5}]', null, null, false);
      raise exception 'Flag editable in phase %', phase;
    exception when object_not_in_prerequisite_state then null;
    end;
    begin
      perform public.save_draft_competition(current_setting('test.voting_draft')::uuid,
        '00000000-0000-0000-0000-000000000711', 'Frozen', 'live', null, null,
        '[{"name":"Quality","max_score":5}]');
      raise exception 'Legacy draft save editable in phase %', phase;
    exception when object_not_in_prerequisite_state then null;
    end;
    perform public.save_competition_details(current_setting('test.voting_draft')::uuid, 'Metadata only', null, null);
    if not (select allow_participant_voting from public.competitions where id = current_setting('test.voting_draft')::uuid) then
      raise exception 'Metadata save changed frozen flag';
    end if;
    reset role;
  end loop;
  update public.competitions set status = 'draft' where id = current_setting('test.voting_draft')::uuid;
end;
$$;

-- Phase/deadline gates apply equally to audience and participating voters.
do $$
declare
  phase text;
  actor text;
begin
  foreach phase in array array['draft', 'submission', 'review_pending', 'results_published', 'voting'] loop
    update public.competitions set status = phase,
      voting_deadline = case when phase = 'voting' then clock_timestamp() - interval '1 second' else null end
    where id = '00000000-0000-0000-0000-000000000722';
    set local role authenticated;
    foreach actor in array array['00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-000000000704'] loop
      perform set_config('request.jwt.claim.sub', actor, true);
      begin
        perform public.save_ballot('00000000-0000-0000-0000-000000000722', 2, current_setting('test.voting_scores')::jsonb);
        raise exception 'Closed voting accepted ballot';
      exception when object_not_in_prerequisite_state then null;
      end;
      begin
        perform public.get_blind_voting_entries('00000000-0000-0000-0000-000000000722');
        raise exception 'Closed voting revealed entries';
      exception when insufficient_privilege then null;
      end;
      -- Owners still read their own submissions during submission, not this other entry.
      if public.can_read_submission_media(current_setting('test.voting_media'))
         or exists (select 1 from storage.objects where name = current_setting('test.voting_media')) then
        raise exception 'Closed voting revealed other entry media';
      end if;
    end loop;
    reset role;
  end loop;
  update public.competitions set status = 'voting', voting_deadline = null
  where id = '00000000-0000-0000-0000-000000000722';
end;
$$;

delete from public.group_members where user_id = '00000000-0000-0000-0000-000000000706';
set local role authenticated;
do $$
declare
  actor text;
begin
  foreach actor in array array[
    '', '00000000-0000-0000-0000-000000000705', -- No identity / unjoined member.
    '00000000-0000-0000-0000-000000000706', -- Joined, but membership revoked.
    '00000000-0000-0000-0000-000000000707', -- Other tenant administrator.
    '00000000-0000-0000-0000-000000000701'  -- Admins must also join to vote.
  ] loop
    perform set_config('request.jwt.claim.sub', actor, true);
    begin
      perform public.save_ballot('00000000-0000-0000-0000-000000000722', 2, current_setting('test.voting_scores')::jsonb);
      raise exception 'Ineligible voter accepted: %', actor;
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.get_blind_voting_entries('00000000-0000-0000-0000-000000000722');
      raise exception 'Ineligible voter browsed: %', actor;
    exception when insufficient_privilege then null;
    end;
    if actor <> '00000000-0000-0000-0000-000000000701'
       and (public.can_read_submission_media(current_setting('test.voting_media'))
         or exists (select 1 from storage.objects where name = current_setting('test.voting_media'))) then
      raise exception 'Ineligible voter accessed media: %', actor;
    end if;
  end loop;
  -- Administrative review access remains independent of joining.
  if not public.can_read_submission_media(current_setting('test.voting_media')) then
    raise exception 'Admin review media access was removed';
  end if;
end;
$$;
reset role;
delete from public.group_members where user_id = '00000000-0000-0000-0000-000000000701';
set local role authenticated;
do $$
declare
  actor text;
begin
  foreach actor in array array[
    '', '00000000-0000-0000-0000-000000000702',
    '00000000-0000-0000-0000-000000000707', '00000000-0000-0000-0000-000000000701'
  ] loop
    perform set_config('request.jwt.claim.sub', actor, true);
    begin
      perform public.save_draft_competition(current_setting('test.voting_draft')::uuid,
        '00000000-0000-0000-0000-000000000711', 'Unauthorized', 'live', null, null,
        '[{"name":"Quality","max_score":5}]', null, null, false);
      raise exception 'Unauthorized flag edit: %', actor;
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.save_draft_competition(null, '00000000-0000-0000-0000-000000000711',
        'Unauthorized', 'live', null, null, '[{"name":"Quality","max_score":5}]', null, null, true);
      raise exception 'Unauthorized flag creation: %', actor;
    exception when insufficient_privilege then null;
    end;
  end loop;
end;
$$;
reset role;

set local role anon;
do $$
begin
  begin
    perform public.save_ballot('00000000-0000-0000-0000-000000000722', 2, current_setting('test.voting_scores')::jsonb);
    raise exception 'Anonymous ballot execution allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_blind_voting_entries('00000000-0000-0000-0000-000000000722');
    raise exception 'Anonymous blind execution allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.save_draft_competition(null, '00000000-0000-0000-0000-000000000711',
      'Anonymous', 'live', null, null, '[{"name":"Quality","max_score":5}]', null, null, true);
    raise exception 'Anonymous draft execution allowed';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

do $$
declare
  signature text;
  forbidden_role text;
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
      and proname = 'save_draft_competition') <> 1
     or to_regprocedure('public.save_draft_competition(uuid,uuid,text,text,timestamptz,timestamptz,jsonb,text,text)') is not null then
    raise exception 'Old draft RPC signature must be replaced, not overloaded';
  end if;
  foreach signature in array array[
    'public.save_draft_competition(uuid,uuid,text,text,timestamptz,timestamptz,jsonb,text,text,boolean)',
    'public.save_ballot(uuid,bigint,jsonb)',
    'public.get_blind_voting_entries(uuid)',
    'public.can_read_submission_media(text)'
  ] loop
    if not has_function_privilege('authenticated', signature, 'EXECUTE')
       or not exists (select 1 from pg_proc where oid = signature::regprocedure
         and prosecdef and proconfig @> array['search_path=""']) then
      raise exception 'RPC must be authenticated, security definer with empty search path: %', signature;
    end if;
    foreach forbidden_role in array array['anon', 'service_role'] loop
      if has_function_privilege(forbidden_role, signature, 'EXECUTE') then
        raise exception 'Forbidden role % can execute %', forbidden_role, signature;
      end if;
    end loop;
  end loop;
  foreach forbidden_role in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(forbidden_role, 'public.cast_vote(uuid,bigint,uuid,integer)', 'EXECUTE') then
      raise exception 'Obsolete vote API accessible to %', forbidden_role;
    end if;
  end loop;
  if not exists (select 1 from pg_proc where oid =
      'public.save_draft_competition(uuid,uuid,text,text,timestamptz,timestamptz,jsonb,text,text,boolean)'::regprocedure
      and lower(prosrc) like '%for update%')
     or not exists (select 1 from pg_proc where oid = 'public.save_ballot(uuid,bigint,jsonb)'::regprocedure
      and lower(prosrc) like '%for update%') then
    raise exception 'Draft and ballot RPCs must retain competition row locks';
  end if;
end;
$$;
rollback;
