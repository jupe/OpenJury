-- Run with psql as the database owner after applying all migrations.
-- All fixtures and RPC-created groups are rolled back.
begin;

insert into auth.users (id) values
  ('00000000-0000-0000-0000-000000000101'),
  ('00000000-0000-0000-0000-000000000102'),
  ('00000000-0000-0000-0000-000000000103');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000101', true);
select public.create_group('Managed group');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000102', true);
select public.create_group('Audited group');

reset role;
insert into public.group_members (group_id, user_id)
select id, '00000000-0000-0000-0000-000000000102'
from public.groups where created_by = '00000000-0000-0000-0000-000000000101';

insert into public.competitions (id, group_id, name, event_type)
select '00000000-0000-0000-0000-000000000111', id, 'Managed competition', 'live'
from public.groups where created_by = '00000000-0000-0000-0000-000000000101';
insert into public.competitions (id, group_id, name, event_type)
select '00000000-0000-0000-0000-000000000112', id, 'Audited competition', 'live'
from public.groups where created_by = '00000000-0000-0000-0000-000000000102';
insert into public.entries (id, competition_id, creator_id, title)
values ('00000000-0000-0000-0000-000000000113', '00000000-0000-0000-0000-000000000112',
        '00000000-0000-0000-0000-000000000102', 'Audited entry');
insert into public.entry_disqualification_events (entry_id, actor_id, reason)
values ('00000000-0000-0000-0000-000000000113',
        '00000000-0000-0000-0000-000000000102', 'Retained audit record');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000102', true);
do $$
declare
  managed_group uuid;
begin
  select id into managed_group from public.groups
    where created_by = '00000000-0000-0000-0000-000000000101';

  begin
    perform public.rename_group(managed_group, 'Unauthorized rename');
    raise exception 'Group member renamed a group';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.delete_group(managed_group);
    raise exception 'Group member removed a group';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.delete_group((
      select id from public.groups
      where created_by = '00000000-0000-0000-0000-000000000102'
    ));
    raise exception 'Group with disqualification audit records was removed';
  exception when foreign_key_violation then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000103', true);
do $$
declare
  managed_group uuid;
begin
  select id into managed_group from public.groups
    where created_by = '00000000-0000-0000-0000-000000000101';
  begin
    perform public.rename_group(managed_group, 'Unauthorized rename');
    raise exception 'Non-member renamed a group';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.delete_group(managed_group);
    raise exception 'Non-member removed a group';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000101', true);
do $$
declare
  managed_group uuid;
begin
  select id into managed_group from public.groups
    where created_by = auth.uid();

  perform public.rename_group(managed_group, '  Renamed group  ');
  if (select name from public.groups where id = managed_group) <> 'Renamed group' then
    raise exception 'Group rename did not trim the name';
  end if;

  begin
    perform public.rename_group(managed_group, '   ');
    raise exception 'Blank group name accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.rename_group(managed_group, repeat('x', 101));
    raise exception 'Long group name accepted';
  exception when invalid_parameter_value then null;
  end;

  perform public.delete_group(managed_group);
  if exists (select 1 from public.groups where id = managed_group)
     or exists (select 1 from public.group_members where group_id = managed_group)
     or exists (select 1 from public.competitions where group_id = managed_group) then
    raise exception 'Group removal did not delete its dependent data';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000102', true);
do $$
declare
  audited_group uuid;
begin
  select id into audited_group from public.groups where created_by = auth.uid();
  begin
    perform public.delete_group(audited_group);
    raise exception 'Group with retained audit data was removed';
  exception when foreign_key_violation then null;
  end;
  if not exists (select 1 from public.groups where id = audited_group)
     or not exists (
       select 1 from public.entry_disqualification_events
       where entry_id = '00000000-0000-0000-0000-000000000113'
     ) then
    raise exception 'Failed removal changed the group or its audit data';
  end if;
end;
$$;

reset role;
rollback;
