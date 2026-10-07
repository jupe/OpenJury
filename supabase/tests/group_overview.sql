-- Run with psql as the database owner after applying all migrations.
-- All fixtures and RPC-created data are rolled back.
begin;

insert into auth.users (id) values
  ('00000000-0000-0000-0000-000000000301'),
  ('00000000-0000-0000-0000-000000000302'),
  ('00000000-0000-0000-0000-000000000303');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000301', true);
select public.create_group('Overview group');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000303', true);
select public.create_group('Other overview group');

reset role;
insert into public.group_members (group_id, user_id)
select id, '00000000-0000-0000-0000-000000000302'
from public.groups where name = 'Overview group';
insert into public.competitions (group_id, name, event_type, status)
select id, competition.name, 'live', competition.status
from public.groups
cross join (values ('Draft', 'draft'), ('Open', 'submission'), ('Voting', 'voting'),
  ('In review', 'review_pending')) as competition(name, status)
where groups.name = 'Overview group';

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000302', true);
do $$
declare
  overview record;
  overview_count integer;
begin
  select count(*) into overview_count from public.get_my_groups();
  if overview_count <> 1 then
    raise exception 'Member saw % groups instead of only their own', overview_count;
  end if;

  select * into overview from public.get_my_groups();
  if overview.name <> 'Overview group'
     or overview.my_role <> 'member'
     or overview.member_count <> 2
     or overview.admin_count <> 1
     or overview.competition_count <> 4
     or overview.active_competition_count <> 2 then
    raise exception 'Unexpected group overview: %', overview;
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000301', true);
do $$
begin
  if (select my_role from public.get_my_groups()) <> 'admin' then
    raise exception 'Group creator was not reported as admin';
  end if;
end;
$$;

reset role;
set local role anon;
do $$
begin
  begin
    perform public.get_my_groups();
    raise exception 'Anonymous caller read group overviews';
  exception when insufficient_privilege then null;
  end;
end;
$$;

rollback;
