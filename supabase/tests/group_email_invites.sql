-- Run with psql as the database owner after applying all migrations.
-- All fixtures are rolled back.
begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000501', 'admin@example.com'),
  ('00000000-0000-0000-0000-000000000502', 'registered@example.com');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000501', true);
select public.create_group('Invitation tests');

do $$
declare
  test_group_id uuid;
begin
  select id into test_group_id from public.groups
    where created_by = auth.uid();

  perform public.invite_group_member_by_email(test_group_id, ' Pending@Example.com ');
  perform public.invite_group_member_by_email(test_group_id, 'pending@example.com');
  if (select count(*) from public.group_email_invites
      where group_id = test_group_id and email = 'pending@example.com') <> 1 then
    raise exception 'A pending invitation could not be resent idempotently';
  end if;

  begin
    perform public.invite_group_member_by_email(test_group_id, 'REGISTERED@example.com');
    raise exception 'An existing account was invited by email';
  exception when raise_exception then
    if sqlerrm <> 'This email is already registered. Use an invite link instead.' then
      raise;
    end if;
  end;
  if exists (select 1 from public.group_email_invites
      where group_id = test_group_id and email = 'registered@example.com') then
    raise exception 'An existing account received a pending email invitation';
  end if;
end;
$$;

rollback;
