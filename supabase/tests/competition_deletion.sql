-- Run with psql as the database owner after applying all migrations.
-- All fixtures and RPC-created data are rolled back.
begin;

insert into auth.users (id) values
  ('00000000-0000-0000-0000-000000000201'),
  ('00000000-0000-0000-0000-000000000202'),
  ('00000000-0000-0000-0000-000000000203');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000201', true);
select public.create_group('Competition deletion');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select public.create_group('Audited competition deletion');

reset role;
insert into public.group_members (group_id, user_id)
select id, '00000000-0000-0000-0000-000000000202'
from public.groups where name = 'Competition deletion';

insert into public.competitions (id, group_id, name, event_type)
select '00000000-0000-0000-0000-000000000211', id, 'Removable', 'live'
from public.groups where name = 'Competition deletion';
insert into public.competitions (id, group_id, name, event_type)
select '00000000-0000-0000-0000-000000000212', id, 'Audited', 'live'
from public.groups where name = 'Audited competition deletion';
insert into public.categories (competition_id, name)
values ('00000000-0000-0000-0000-000000000211', 'Taste');
insert into public.entries (id, competition_id, creator_id, title)
values ('00000000-0000-0000-0000-000000000213',
        '00000000-0000-0000-0000-000000000212',
        '00000000-0000-0000-0000-000000000202', 'Audited entry');
insert into public.entry_disqualification_events (entry_id, actor_id, reason)
values ('00000000-0000-0000-0000-000000000213',
        '00000000-0000-0000-0000-000000000202', 'Retained audit record');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
do $$
begin
  begin
    perform public.delete_competition('00000000-0000-0000-0000-000000000211');
    raise exception 'Group member removed a competition';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.delete_competition('00000000-0000-0000-0000-000000000212');
    raise exception 'Competition with audit records was removed';
  exception when foreign_key_violation then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000203', true);
do $$
begin
  begin
    perform public.delete_competition('00000000-0000-0000-0000-000000000211');
    raise exception 'Non-member removed a competition';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000201', true);
do $$
begin
  perform public.delete_competition('00000000-0000-0000-0000-000000000211');
  if exists (
    select 1 from public.competitions
    where id = '00000000-0000-0000-0000-000000000211'
  ) or exists (
    select 1 from public.categories
    where competition_id = '00000000-0000-0000-0000-000000000211'
  ) then
    raise exception 'Competition deletion did not cascade to dependent data';
  end if;

  begin
    perform public.delete_competition('00000000-0000-0000-0000-000000000299');
    raise exception 'Missing competition was removed';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
do $$
begin
  if exists (
    select 1 from public.entry_disqualification_events
    where entry_id = '00000000-0000-0000-0000-000000000213'
  ) then
    raise exception 'Failed removal deleted its audit record';
  end if;
  if has_function_privilege('anon', 'public.delete_competition(uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.delete_competition(uuid)', 'EXECUTE') then
    raise exception 'Competition deletion RPC permissions are invalid';
  end if;
end;
$$;

rollback;
