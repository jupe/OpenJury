-- Run with psql as the database owner after applying all migrations.
-- Fixtures and membership changes are rolled back.
begin;

insert into auth.users (id) values
  ('00000000-0000-0000-0000-000000000051'),
  ('00000000-0000-0000-0000-000000000052'),
  ('00000000-0000-0000-0000-000000000053');

insert into public.groups (id, name, created_by) values
  ('00000000-0000-0000-0000-000000000061', 'Realtime group one', '00000000-0000-0000-0000-000000000051'),
  ('00000000-0000-0000-0000-000000000062', 'Realtime group two', '00000000-0000-0000-0000-000000000052');

insert into public.group_members (group_id, user_id, role) values
  ('00000000-0000-0000-0000-000000000061', '00000000-0000-0000-0000-000000000051', 'admin'),
  ('00000000-0000-0000-0000-000000000062', '00000000-0000-0000-0000-000000000052', 'admin');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000051', true);

do $$
begin
  if not public.can_receive_realtime_topic('group:00000000-0000-0000-0000-000000000061')
     or public.can_receive_realtime_topic('group:00000000-0000-0000-0000-000000000062')
     or not public.can_receive_realtime_topic('user:00000000-0000-0000-0000-000000000051')
     or public.can_receive_realtime_topic('user:00000000-0000-0000-0000-000000000052')
     or public.can_receive_realtime_topic('group:not-a-uuid') then
    raise exception 'Realtime topic authorization did not enforce tenant and user isolation';
  end if;

  if has_table_privilege('authenticated', 'realtime.messages', 'INSERT') then
    raise exception 'Authenticated clients must not send forged broadcast messages';
  end if;
end;
$$;

reset role;
delete from public.group_members
where group_id = '00000000-0000-0000-0000-000000000061'
  and user_id = '00000000-0000-0000-0000-000000000051';

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000051', true);

do $$
begin
  if public.can_receive_realtime_topic('group:00000000-0000-0000-0000-000000000061')
     or not public.can_receive_realtime_topic('user:00000000-0000-0000-0000-000000000051') then
    raise exception 'A revoked member retained group notifications or lost their private revocation channel';
  end if;
end;
$$;

reset role;
do $$
declare
  trigger_function text;
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'realtime'
      and tablename = 'messages'
      and policyname = 'OpenJury members receive private notifications'
  ) then
    raise exception 'Realtime messages are missing the membership authorization policy';
  end if;

  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename in ('entries', 'votes')
  ) then
    raise exception 'Sensitive entry or vote rows were added to the Realtime publication';
  end if;

  if exists (
    select 1
    from (values
      ('groups'), ('group_members'), ('competitions'), ('categories'),
      ('entries'), ('votes'), ('entry_disqualification_events'),
      ('published_competition_results')
    ) as expected(table_name)
    where not exists (
      select 1 from pg_trigger
      where tgrelid = format('public.%I', expected.table_name)::regclass
        and tgname = expected.table_name || '_broadcast_change'
        and not tgisinternal
    )
  ) then
    raise exception 'A user-visible data table is missing its notification trigger';
  end if;

  select pg_get_functiondef('public.broadcast_group_change()'::regprocedure)
    into trigger_function;
  if position('jsonb_build_object(''version'', 1)' in trigger_function) = 0
     or position('to_jsonb' in trigger_function) > 0 then
    raise exception 'Realtime notifications must contain only the fixed version marker';
  end if;
end;
$$;

rollback;
