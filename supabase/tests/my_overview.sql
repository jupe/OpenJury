-- Run with psql as the database owner after applying all migrations.
-- All fixtures and RPC-created data are rolled back.
begin;

insert into auth.users (id) values
  ('00000000-0000-0000-0000-000000000401'),
  ('00000000-0000-0000-0000-000000000402'),
  ('00000000-0000-0000-0000-000000000403');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000401', true);
select public.create_group('Overview home');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000403', true);
select public.create_group('Unrelated home');

reset role;
insert into public.group_members (group_id, user_id)
select id, '00000000-0000-0000-0000-000000000402' from public.groups where name = 'Overview home';
insert into public.competitions (id, group_id, name, event_type, status)
select competition.id::uuid, groups.id, competition.name, 'live', competition.status
from public.groups
cross join (values
  ('00000000-0000-0000-0000-000000000411', 'Open', 'submission'),
  ('00000000-0000-0000-0000-000000000412', 'Voting', 'voting'),
  ('00000000-0000-0000-0000-000000000413', 'Won', 'results_published'),
  ('00000000-0000-0000-0000-000000000414', 'Third', 'results_published')
) as competition(id, name, status)
where groups.name = 'Overview home';
insert into public.competitions (id, group_id, name, event_type, status)
select '00000000-0000-0000-0000-000000000415', id, 'Elsewhere', 'live', 'voting'
from public.groups where name = 'Unrelated home';

insert into public.entries (id, competition_id, creator_id, title) values
  ('00000000-0000-0000-0000-000000000421', '00000000-0000-0000-0000-000000000413', '00000000-0000-0000-0000-000000000402', 'Winner'),
  ('00000000-0000-0000-0000-000000000422', '00000000-0000-0000-0000-000000000414', '00000000-0000-0000-0000-000000000402', 'Third place'),
  ('00000000-0000-0000-0000-000000000423', '00000000-0000-0000-0000-000000000413', '00000000-0000-0000-0000-000000000401', 'Runner-up'),
  ('00000000-0000-0000-0000-000000000424', '00000000-0000-0000-0000-000000000411', '00000000-0000-0000-0000-000000000402', 'Pending');
insert into public.published_competition_results (competition_id, entry_id, rank, score, vote_count) values
  ('00000000-0000-0000-0000-000000000413', '00000000-0000-0000-0000-000000000421', 1, 0.9, 2),
  ('00000000-0000-0000-0000-000000000413', '00000000-0000-0000-0000-000000000423', 2, 0.8, 2),
  ('00000000-0000-0000-0000-000000000414', '00000000-0000-0000-0000-000000000422', 3, 0.5, 2);
insert into public.categories (id, competition_id, name)
values ('00000000-0000-0000-0000-000000000431', '00000000-0000-0000-0000-000000000413', 'Taste');
insert into public.votes (entry_id, voter_id, category_id, score) values
  ('00000000-0000-0000-0000-000000000423', '00000000-0000-0000-0000-000000000402', '00000000-0000-0000-0000-000000000431', 4);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000402', true);
do $$
declare
  overview record;
begin
  select * into strict overview from public.get_my_overview();
  if overview.group_count <> 1
     or overview.active_competition_count <> 2
     or overview.entry_count <> 3
     or overview.voted_entry_count <> 1
     or overview.win_count <> 1
     or overview.podium_count <> 2 then
    raise exception 'Unexpected member overview: %', overview;
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000401', true);
do $$
declare
  overview record;
begin
  select * into strict overview from public.get_my_overview();
  if overview.entry_count <> 1 or overview.win_count <> 0 or overview.podium_count <> 1
     or overview.voted_entry_count <> 0 then
    raise exception 'Unexpected admin overview: %', overview;
  end if;
end;
$$;

-- Actions: member 402 is a participant without an entry in 'Open' (submit),
-- audience in 'Voting' with an unscored entry (vote); admin 401 has no roles (join).
reset role;
insert into public.competition_participants (competition_id, user_id, role) values
  ('00000000-0000-0000-0000-000000000411', '00000000-0000-0000-0000-000000000402', 'participant'),
  ('00000000-0000-0000-0000-000000000412', '00000000-0000-0000-0000-000000000402', 'audience');
delete from public.entries where id = '00000000-0000-0000-0000-000000000424';
insert into public.entries (id, competition_id, creator_id, title) values
  ('00000000-0000-0000-0000-000000000425', '00000000-0000-0000-0000-000000000412', '00000000-0000-0000-0000-000000000401', 'To score');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000402', true);
do $$
declare
  actions text;
begin
  select string_agg(competition_id::text || ':' || action, ',' order by competition_id) into actions
  from public.get_my_competition_actions();
  if actions is distinct from '00000000-0000-0000-0000-000000000411:submit,00000000-0000-0000-0000-000000000412:vote' then
    raise exception 'Unexpected member actions: %', actions;
  end if;
end;
$$;

reset role;
insert into public.entries (id, competition_id, creator_id, title) values
  ('00000000-0000-0000-0000-000000000426', '00000000-0000-0000-0000-000000000411', '00000000-0000-0000-0000-000000000402', 'Submitted');
insert into public.categories (id, competition_id, name)
values ('00000000-0000-0000-0000-000000000432', '00000000-0000-0000-0000-000000000412', 'Taste');
insert into public.votes (entry_id, voter_id, category_id, score) values
  ('00000000-0000-0000-0000-000000000425', '00000000-0000-0000-0000-000000000402', '00000000-0000-0000-0000-000000000432', 3);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000402', true);
do $$
begin
  if exists (select 1 from public.get_my_competition_actions()) then
    raise exception 'Submitted and fully voted competitions still need action';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000401', true);
do $$
declare
  actions text;
begin
  select string_agg(action, ',' order by competition_id) into actions from public.get_my_competition_actions();
  if actions is distinct from 'join,join' then
    raise exception 'Unexpected admin actions: %', actions;
  end if;
end;
$$;

reset role;
update public.entries set is_disqualified = true where id = '00000000-0000-0000-0000-000000000421';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000402', true);
do $$
begin
  if (select win_count from public.get_my_overview()) <> 0 then
    raise exception 'Disqualified entry still counted as a win';
  end if;
end;
$$;

reset role;
set local role anon;
do $$
begin
  begin
    perform public.get_my_overview();
    raise exception 'Anonymous caller read an overview';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_my_competition_actions();
    raise exception 'Anonymous caller read competition actions';
  exception when insufficient_privilege then null;
  end;
end;
$$;

rollback;
