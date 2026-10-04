-- Run with psql as the database owner after applying all migrations.
-- All fixtures and RPC-created groups are rolled back.
begin;

insert into auth.users (id) values
  ('00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000003');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
select public.create_group('  First group  ');

do $$
begin
  if (select count(*) from public.groups) <> 1
     or (select name from public.groups) <> 'First group'
     or (select created_by from public.groups) <> auth.uid()
     or (select count(*) from public.group_members where role = 'admin') <> 1 then
    raise exception 'Group creation must trim names and create the owner membership';
  end if;

  begin
    perform public.create_group('   ');
    raise exception 'Blank group name accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.create_group(null);
    raise exception 'Null group name accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.create_group(repeat('x', 101));
    raise exception 'Long group name accepted';
  exception when invalid_parameter_value then null;
  end;

  begin
    insert into public.groups (name, created_by) values ('Bypass', auth.uid());
    raise exception 'Direct group creation allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.group_members set role = 'member' where user_id = auth.uid();
    raise exception 'Direct membership modification allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.groups;
    raise exception 'Direct group deletion allowed';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
do $$
begin
  if exists (select 1 from public.groups)
     or exists (select 1 from public.group_members) then
    raise exception 'Another tenant can read the first tenant';
  end if;
end;
$$;
select public.create_group('Second group');

reset role;
insert into public.group_members (group_id, user_id)
select id, '00000000-0000-0000-0000-000000000003'
from public.groups where created_by = '00000000-0000-0000-0000-000000000001';

insert into public.competitions (id, group_id, name, event_type)
select '00000000-0000-0000-0000-000000000010', id, 'Private competition', 'live'
from public.groups where created_by = '00000000-0000-0000-0000-000000000001';
insert into public.categories (id, competition_id, name)
values ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000010', 'Taste');
insert into public.entries (id, competition_id, creator_id, title)
values ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000010',
        '00000000-0000-0000-0000-000000000001', 'Private title');
insert into public.votes (entry_id, voter_id, category_id, score)
values ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000011', 5);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', true);
do $$
begin
  if (select count(*) from public.groups) <> 1
     or (select name from public.groups) <> 'First group'
     or (select count(*) from public.group_members) <> 1
     or (select role from public.group_members) <> 'member' then
    raise exception 'Membership-scoped reads are incorrect';
  end if;
  if (select count(*) from public.competitions) <> 1
     or (select name from public.competitions) <> 'Private competition'
     or (select count(*) from public.categories) <> 1 then
    raise exception 'Group members must read competition setup';
  end if;
  if exists (select 1 from public.entries)
     or exists (select 1 from public.votes) then
    raise exception 'Entry and vote data must remain closed';
  end if;
  begin
    insert into public.group_members (group_id, user_id, role)
    select id, auth.uid(), 'admin' from public.groups;
    raise exception 'Membership self-promotion allowed';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  begin
    perform public.create_group('No identity');
    raise exception 'Unauthenticated RPC creation allowed';
  exception when insufficient_privilege then null;
  end;
end;
$$;

set local role anon;
do $$
begin
  begin
    perform public.create_group('Anonymous');
    raise exception 'Anonymous RPC execution allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform id from public.groups;
    raise exception 'Anonymous group access allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform user_id from public.group_members;
    raise exception 'Anonymous membership access allowed';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
do $$
begin
  if (select count(*) from public.groups where created_by in (
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000002'
  )) <> 2 then
    raise exception 'Rejected writes must not leave orphaned groups';
  end if;
end;
$$;

rollback;
