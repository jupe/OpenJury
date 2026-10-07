-- Run with psql as the database owner after applying all migrations.
begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000901', 'admin@example.invalid', '{"display_name":"  Admin Name  ","full_name":"Ignored"}'),
  ('00000000-0000-0000-0000-000000000902', 'member@example.invalid', '{"display_name":" ","full_name":"  Full Name  "}'),
  ('00000000-0000-0000-0000-000000000903', 'unnamed@example.invalid', '{}'),
  ('00000000-0000-0000-0000-000000000904', 'other@example.invalid', '{"display_name":"Other tenant"}');
insert into public.groups (id, name, created_by) values
  ('00000000-0000-0000-0000-000000000911', 'Named members', '00000000-0000-0000-0000-000000000901');
insert into public.group_members (group_id, user_id, role) values
  ('00000000-0000-0000-0000-000000000911', '00000000-0000-0000-0000-000000000901', 'admin'),
  ('00000000-0000-0000-0000-000000000911', '00000000-0000-0000-0000-000000000902', 'member'),
  ('00000000-0000-0000-0000-000000000911', '00000000-0000-0000-0000-000000000903', 'member');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000901', true);
do $$
begin
  if (select count(*) from public.get_group_members('00000000-0000-0000-0000-000000000911')) <> 3 then
    raise exception 'Member projection leaked another tenant or lost members';
  end if;
  if (select display_name from public.get_group_members('00000000-0000-0000-0000-000000000911')
      where user_id = auth.uid()) is distinct from 'Admin Name' then
    raise exception 'Own display name was not preferred and trimmed';
  end if;
  if (select display_name from public.get_group_members('00000000-0000-0000-0000-000000000911')
      where user_id = '00000000-0000-0000-0000-000000000902') is distinct from 'Full Name' then
    raise exception 'Metadata name fallback was not preserved';
  end if;
  if not exists (select 1 from public.get_group_members('00000000-0000-0000-0000-000000000911')
      where user_id = '00000000-0000-0000-0000-000000000903'
        and display_name is null and email = 'unnamed@example.invalid') then
    raise exception 'Unnamed member email fallback was not preserved';
  end if;
  begin
    update auth.users set raw_user_meta_data = '{"display_name":"Admin-defined"}'
      where id = '00000000-0000-0000-0000-000000000902';
    raise exception 'Group admin could define another user name';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000902', true);
do $$
begin
  begin
    perform public.get_group_members('00000000-0000-0000-0000-000000000911');
    raise exception 'Ordinary member could read identities';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000904', true);
do $$
begin
  begin
    perform public.get_group_members('00000000-0000-0000-0000-000000000911');
    raise exception 'Non-member could read identities';
  exception when insufficient_privilege then null;
  end;
end;
$$;

set local role anon;
do $$
begin
  begin
    perform public.get_group_members('00000000-0000-0000-0000-000000000911');
    raise exception 'Anonymous user could read identities';
  exception when insufficient_privilege then null;
  end;
end;
$$;

rollback;
