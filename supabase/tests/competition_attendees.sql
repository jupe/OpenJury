-- Run with psql as the database owner after applying all migrations.
-- Fixtures and membership revocations are rolled back.
begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000201', 'admin@example.invalid',
   '{"display_name":"  Admin  ","full_name":"Ignored","name":"Ignored"}'),
  ('00000000-0000-0000-0000-000000000202', 'full@example.invalid',
   '{"display_name":"  ","full_name":"  Full Name  ","name":"Ignored"}'),
  ('00000000-0000-0000-0000-000000000203', 'inactive@example.invalid', null),
  ('00000000-0000-0000-0000-000000000204', 'name@example.invalid',
   '{"display_name":"","full_name":" ","name":"  Short Name  "}'),
  ('00000000-0000-0000-0000-000000000205', '  email@example.invalid  ',
   '{"display_name":" ","full_name":"","name":" "}'),
  ('00000000-0000-0000-0000-000000000206', '  ', '{"display_name":"","full_name":" ","name":""}'),
  ('00000000-0000-0000-0000-000000000207', 'former@example.invalid',
   '{"display_name":"  Former Creator  "}'),
  ('00000000-0000-0000-0000-000000000208', 'former-voter@example.invalid', '{}'),
  ('00000000-0000-0000-0000-000000000209', 'dual@example.invalid',
   '{"display_name":"  Dual  ","full_name":"Ignored","name":"Ignored"}'),
  ('00000000-0000-0000-0000-000000000210', 'other@example.invalid', '{"name":"Other tenant"}'),
  ('00000000-0000-0000-0000-000000000211', 'audit@example.invalid', '{"name":"Audit-only admin"}'),
  ('00000000-0000-0000-0000-000000000212', 'other-event@example.invalid', '{}');

insert into public.groups (id, name, created_by) values
  ('00000000-0000-0000-0000-000000000231', 'Attendee tenant', '00000000-0000-0000-0000-000000000201'),
  ('00000000-0000-0000-0000-000000000232', 'Other attendee tenant', '00000000-0000-0000-0000-000000000210');
insert into public.group_members (group_id, user_id, role)
select '00000000-0000-0000-0000-000000000231', member.user_id, member.role
from (values
  ('00000000-0000-0000-0000-000000000201'::uuid, 'admin'),
  ('00000000-0000-0000-0000-000000000202'::uuid, 'member'),
  ('00000000-0000-0000-0000-000000000203'::uuid, 'member'),
  ('00000000-0000-0000-0000-000000000204'::uuid, 'member'),
  ('00000000-0000-0000-0000-000000000205'::uuid, 'member'),
  ('00000000-0000-0000-0000-000000000206'::uuid, 'member'),
  ('00000000-0000-0000-0000-000000000207'::uuid, 'member'),
  ('00000000-0000-0000-0000-000000000208'::uuid, 'member'),
  ('00000000-0000-0000-0000-000000000209'::uuid, 'admin'),
  ('00000000-0000-0000-0000-000000000211'::uuid, 'admin'),
  ('00000000-0000-0000-0000-000000000212'::uuid, 'member')
) as member(user_id, role);
insert into public.group_members (group_id, user_id, role) values
  ('00000000-0000-0000-0000-000000000232', '00000000-0000-0000-0000-000000000210', 'admin');
insert into public.competitions (id, group_id, name, event_type, status) values
  ('00000000-0000-0000-0000-000000000221', '00000000-0000-0000-0000-000000000231', 'Attendee competition', 'live', 'results_published'),
  ('00000000-0000-0000-0000-000000000222', '00000000-0000-0000-0000-000000000231', 'Other group competition', 'live', 'voting'),
  ('00000000-0000-0000-0000-000000000223', '00000000-0000-0000-0000-000000000232', 'Other tenant competition', 'live', 'results_published'),
  ('00000000-0000-0000-0000-000000000224', '00000000-0000-0000-0000-000000000231', 'Empty draft competition', 'live', 'draft');
insert into public.competitions (id, group_id, name, event_type, status, allow_participant_voting) values
  ('00000000-0000-0000-0000-000000000225', '00000000-0000-0000-0000-000000000231', 'Participation progress', 'live', 'voting', true);
insert into public.categories (id, competition_id, name) values
  ('00000000-0000-0000-0000-000000000241', '00000000-0000-0000-0000-000000000221', 'Quality'),
  ('00000000-0000-0000-0000-000000000242', '00000000-0000-0000-0000-000000000221', 'Style'),
  ('00000000-0000-0000-0000-000000000243', '00000000-0000-0000-0000-000000000222', 'Quality'),
  ('00000000-0000-0000-0000-000000000245', '00000000-0000-0000-0000-000000000225', 'Quality'),
  ('00000000-0000-0000-0000-000000000246', '00000000-0000-0000-0000-000000000225', 'Style');
insert into public.competition_participants (competition_id, user_id, role) values
  ('00000000-0000-0000-0000-000000000225', '00000000-0000-0000-0000-000000000202', 'participant'),
  ('00000000-0000-0000-0000-000000000225', '00000000-0000-0000-0000-000000000204', 'participant'),
  ('00000000-0000-0000-0000-000000000225', '00000000-0000-0000-0000-000000000209', 'audience');
insert into public.entries (id, competition_id, creator_id, title, is_disqualified) values
  ('00000000-0000-0000-0000-000000000251', '00000000-0000-0000-0000-000000000221', '00000000-0000-0000-0000-000000000202', 'Full name entry', false),
  ('00000000-0000-0000-0000-000000000252', '00000000-0000-0000-0000-000000000221', '00000000-0000-0000-0000-000000000204', 'Short name entry', false),
  ('00000000-0000-0000-0000-000000000253', '00000000-0000-0000-0000-000000000221', '00000000-0000-0000-0000-000000000205', 'Email fallback entry', false),
  ('00000000-0000-0000-0000-000000000254', '00000000-0000-0000-0000-000000000221', '00000000-0000-0000-0000-000000000206', 'Participant entry', false),
  ('00000000-0000-0000-0000-000000000255', '00000000-0000-0000-0000-000000000221', '00000000-0000-0000-0000-000000000207', 'Former entry', true),
  ('00000000-0000-0000-0000-000000000256', '00000000-0000-0000-0000-000000000221', '00000000-0000-0000-0000-000000000209', 'Dual entry', false),
  ('00000000-0000-0000-0000-000000000257', '00000000-0000-0000-0000-000000000222', '00000000-0000-0000-0000-000000000212', 'Other event entry', false),
  ('00000000-0000-0000-0000-000000000258', '00000000-0000-0000-0000-000000000223', '00000000-0000-0000-0000-000000000210', 'Other tenant entry', false);
insert into public.entries (id, competition_id, creator_id, title, random_number, is_disqualified) values
  ('00000000-0000-0000-0000-000000000259', '00000000-0000-0000-0000-000000000225', '00000000-0000-0000-0000-000000000202', 'Progress entry one', 1, false),
  ('00000000-0000-0000-0000-000000000260', '00000000-0000-0000-0000-000000000225', '00000000-0000-0000-0000-000000000204', 'Progress entry two', 2, false);
insert into public.votes (entry_id, voter_id, category_id, score) values
  ('00000000-0000-0000-0000-000000000251', '00000000-0000-0000-0000-000000000208', '00000000-0000-0000-0000-000000000241', 5),
  ('00000000-0000-0000-0000-000000000251', '00000000-0000-0000-0000-000000000208', '00000000-0000-0000-0000-000000000242', 4),
  ('00000000-0000-0000-0000-000000000255', '00000000-0000-0000-0000-000000000209', '00000000-0000-0000-0000-000000000241', 3),
  ('00000000-0000-0000-0000-000000000257', '00000000-0000-0000-0000-000000000209', '00000000-0000-0000-0000-000000000243', 2);
insert into public.votes (entry_id, voter_id, category_id, score) values
  ('00000000-0000-0000-0000-000000000260', '00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000245', 4),
  ('00000000-0000-0000-0000-000000000260', '00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000246', 3),
  ('00000000-0000-0000-0000-000000000259', '00000000-0000-0000-0000-000000000209', '00000000-0000-0000-0000-000000000245', 5),
  ('00000000-0000-0000-0000-000000000259', '00000000-0000-0000-0000-000000000209', '00000000-0000-0000-0000-000000000246', 2),
  ('00000000-0000-0000-0000-000000000260', '00000000-0000-0000-0000-000000000209', '00000000-0000-0000-0000-000000000245', 4),
  ('00000000-0000-0000-0000-000000000260', '00000000-0000-0000-0000-000000000209', '00000000-0000-0000-0000-000000000246', 3);
insert into public.entry_disqualification_events (entry_id, actor_id, reason) values
  ('00000000-0000-0000-0000-000000000255', '00000000-0000-0000-0000-000000000211', 'Audit-only administrator');
delete from public.group_members
where group_id = '00000000-0000-0000-0000-000000000231'
  and user_id in (
    '00000000-0000-0000-0000-000000000207',
    '00000000-0000-0000-0000-000000000208',
    '00000000-0000-0000-0000-000000000211',
    '00000000-0000-0000-0000-000000000212'
  );
insert into public.published_competition_results (competition_id, entry_id, rank, score, vote_count)
select competition_id, id, 1, 80, 1 from public.entries
where competition_id = '00000000-0000-0000-0000-000000000221' and not is_disqualified;
insert into public.published_competition_category_results (
  competition_id, category_id, entry_id, rank, score
) values
  ('00000000-0000-0000-0000-000000000221', '00000000-0000-0000-0000-000000000241',
   '00000000-0000-0000-0000-000000000251', 1, 80),
  ('00000000-0000-0000-0000-000000000221', '00000000-0000-0000-0000-000000000241',
   '00000000-0000-0000-0000-000000000253', 2, 75),
  ('00000000-0000-0000-0000-000000000221', '00000000-0000-0000-0000-000000000241',
   '00000000-0000-0000-0000-000000000254', 3, 70);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000201', true);
do $$
begin
  if exists (
    with expected(user_id, display_name, role, has_submission, has_voted) as (values
      ('00000000-0000-0000-0000-000000000201'::uuid, 'Admin', 'admin', false, false),
      ('00000000-0000-0000-0000-000000000202'::uuid, 'Full Name', 'member', true, false),
      ('00000000-0000-0000-0000-000000000203'::uuid, 'inactive@example.invalid', 'member', false, false),
      ('00000000-0000-0000-0000-000000000204'::uuid, 'Short Name', 'member', true, false),
      ('00000000-0000-0000-0000-000000000205'::uuid, 'email@example.invalid', 'member', true, false),
      ('00000000-0000-0000-0000-000000000206'::uuid, 'Participant', 'member', true, false),
      ('00000000-0000-0000-0000-000000000207'::uuid, 'Former Creator', 'former member', true, false),
      ('00000000-0000-0000-0000-000000000208'::uuid, 'former-voter@example.invalid', 'former member', false, true),
      ('00000000-0000-0000-0000-000000000209'::uuid, 'Dual', 'admin', true, true)
    ),
    actual as (
      select * from public.get_admin_competition_attendees('00000000-0000-0000-0000-000000000221')
    )
    (select * from actual except all select * from expected)
    union all
    (select * from expected except all select * from actual)
  ) then
    raise exception 'Attendees, roles, participation flags, deduplication, or name fallbacks differ';
  end if;
  if (select count(*) from public.get_admin_competition_attendees(
      '00000000-0000-0000-0000-000000000224'
      )) <> 7 or exists (
    select 1 from public.get_admin_competition_attendees('00000000-0000-0000-0000-000000000224')
    where has_submission or has_voted or role = 'former member'
  ) then
    raise exception 'An empty draft must include every current member, without other-event activity';
  end if;
  if (select row(joined_count, participant_count, submitted_count, complete_ballot_count, eligible_voter_count)
      from public.get_admin_competition_participation_progress('00000000-0000-0000-0000-000000000225'))
      is distinct from row(3, 2, 2, 2, 3) then
    raise exception 'Participation progress must aggregate joined, submitted, and complete eligible ballots only';
  end if;

  begin
    perform public.get_admin_competition_attendees('00000000-0000-0000-0000-000000000223');
    raise exception 'Admin accessed another tenant attendees';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_admin_competition_attendees('00000000-0000-0000-0000-000000000299');
    raise exception 'Missing competition was accessible';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.entries;
    raise exception 'Admin read entries directly';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.votes;
    raise exception 'Admin read votes directly';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.entry_disqualification_events;
    raise exception 'Admin read audit data directly';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.published_competition_results;
    raise exception 'Admin read snapshot data directly';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from auth.users;
    raise exception 'Admin read auth profiles directly';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
do $$
begin
  begin
    perform public.get_admin_competition_attendees('00000000-0000-0000-0000-000000000221');
    raise exception 'Member accessed attendees';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_admin_competition_participation_progress('00000000-0000-0000-0000-000000000225');
    raise exception 'Member accessed participation progress';
  exception when insufficient_privilege then null;
  end;
  if exists (
    with expected(rank, score, vote_count, title, creator_id, creator_name) as (values
      (1, 80::numeric, 1, 'Full name entry', '00000000-0000-0000-0000-000000000202'::uuid, 'Full Name'),
      (1, 80::numeric, 1, 'Short name entry', '00000000-0000-0000-0000-000000000204'::uuid, 'Short Name'),
      (1, 80::numeric, 1, 'Email fallback entry', '00000000-0000-0000-0000-000000000205'::uuid, 'email@example.invalid'),
      (1, 80::numeric, 1, 'Participant entry', '00000000-0000-0000-0000-000000000206'::uuid, 'Participant'),
      (1, 80::numeric, 1, 'Dual entry', '00000000-0000-0000-0000-000000000209'::uuid, 'Dual')
    ),
    actual as (
      select rank, score, vote_count, title, creator_id, creator_name
      from public.get_published_competition_results('00000000-0000-0000-0000-000000000221')
    )
    (select * from actual except all select * from expected)
    union all
    (select * from expected except all select * from actual)
  ) then
    raise exception 'Published result creator labels or projection differ';
  end if;
  if exists (
    with expected(category_id, category_name, rank, score, title, creator_name) as (values
      ('00000000-0000-0000-0000-000000000241'::uuid, 'Quality', 1, 80::numeric,
       'Full name entry', 'Full Name'),
      ('00000000-0000-0000-0000-000000000241'::uuid, 'Quality', 2, 75::numeric,
       'Email fallback entry', 'email@example.invalid'),
      ('00000000-0000-0000-0000-000000000241'::uuid, 'Quality', 3, 70::numeric,
       'Participant entry', 'Participant')
    ),
    actual as (
      select * from public.get_published_competition_category_results(
        '00000000-0000-0000-0000-000000000221'
      )
    )
    (select * from actual except all select * from expected)
    union all
    (select * from expected except all select * from actual)
  ) then
    raise exception 'Published category creator labels differ';
  end if;
  begin
    perform public.get_published_competition_results('00000000-0000-0000-0000-000000000222');
    raise exception 'Unpublished results were accessible';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_published_competition_category_results('00000000-0000-0000-0000-000000000222');
    raise exception 'Unpublished category results were accessible';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000210', true);
do $$
begin
  begin
    perform public.get_admin_competition_attendees('00000000-0000-0000-0000-000000000221');
    raise exception 'Other tenant admin accessed attendees';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_admin_competition_participation_progress('00000000-0000-0000-0000-000000000225');
    raise exception 'Other tenant admin accessed participation progress';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_published_competition_results('00000000-0000-0000-0000-000000000221');
    raise exception 'Other tenant admin accessed published results';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_published_competition_category_results('00000000-0000-0000-0000-000000000221');
    raise exception 'Other tenant admin accessed published category results';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  begin
    perform public.get_admin_competition_attendees('00000000-0000-0000-0000-000000000221');
    raise exception 'Missing auth identity accessed attendees';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_admin_competition_participation_progress('00000000-0000-0000-0000-000000000225');
    raise exception 'Missing auth identity accessed participation progress';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_published_competition_results('00000000-0000-0000-0000-000000000221');
    raise exception 'Missing auth identity accessed published results';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_published_competition_category_results('00000000-0000-0000-0000-000000000221');
    raise exception 'Missing auth identity accessed published category results';
  exception when insufficient_privilege then null;
  end;
end;
$$;

set local role anon;
do $$
begin
  begin
    perform public.get_admin_competition_attendees('00000000-0000-0000-0000-000000000221');
    raise exception 'Anonymous client accessed attendees';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_admin_competition_participation_progress('00000000-0000-0000-0000-000000000225');
    raise exception 'Anonymous client accessed participation progress';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_published_competition_results('00000000-0000-0000-0000-000000000221');
    raise exception 'Anonymous client accessed published results';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_published_competition_category_results('00000000-0000-0000-0000-000000000221');
    raise exception 'Anonymous client accessed published category results';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
do $$
declare
  rpc regprocedure;
begin
  foreach rpc in array array[
    'public.get_admin_competition_attendees(uuid)'::regprocedure,
    'public.get_admin_competition_participation_progress(uuid)'::regprocedure,
    'public.get_published_competition_results(uuid)'::regprocedure,
    'public.get_published_competition_category_results(uuid)'::regprocedure
  ] loop
    if has_function_privilege('anon', rpc, 'execute')
       or has_function_privilege('service_role', rpc, 'execute')
       or not has_function_privilege('authenticated', rpc, 'execute')
       or not exists (
         select 1 from pg_proc
         where oid = rpc and prosecdef and proconfig = array['search_path=""']
       ) then
      raise exception 'RPC grants or security-definer search path are unsafe: %', rpc;
    end if;
  end loop;
  if (select proargnames from pg_proc
      where oid = 'public.get_admin_competition_attendees(uuid)'::regprocedure)
     <> array['p_competition_id', 'user_id', 'display_name', 'role', 'has_submission', 'has_voted'] then
    raise exception 'Attendee projection must expose participation only, not ballot contents';
  end if;
  if (select proargnames from pg_proc
    where oid = 'public.get_admin_competition_participation_progress(uuid)'::regprocedure)
   <> array['p_competition_id', 'joined_count', 'participant_count', 'submitted_count',
            'complete_ballot_count', 'eligible_voter_count'] then
  raise exception 'Participation progress must return aggregate counts only';
  end if;
end;
$$;

delete from public.group_members
where group_id = '00000000-0000-0000-0000-000000000231'
  and user_id = '00000000-0000-0000-0000-000000000201';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000201', true);
do $$
begin
  begin
    perform public.get_admin_competition_attendees('00000000-0000-0000-0000-000000000221');
    raise exception 'Revoked administrator accessed attendees';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_admin_competition_participation_progress('00000000-0000-0000-0000-000000000225');
    raise exception 'Revoked administrator accessed participation progress';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_published_competition_results('00000000-0000-0000-0000-000000000221');
    raise exception 'Revoked administrator accessed published results';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_published_competition_category_results('00000000-0000-0000-0000-000000000221');
    raise exception 'Revoked administrator accessed published category results';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
rollback;
