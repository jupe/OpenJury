-- Run with psql as the database owner after applying all migrations.
-- All fixtures are rolled back.
begin;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-000000000501', 'admin@example.com', now()),
  ('00000000-0000-0000-0000-000000000502', 'registered@example.com', now()),
  ('00000000-0000-0000-0000-000000000503', 'unconfirmed@example.com', null);

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
  if (select count(*) from public.get_group_email_invites(test_group_id)
      where email = 'pending@example.com') <> 1 then
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
  if exists (select 1 from public.get_group_email_invites(test_group_id)
      where email = 'registered@example.com') then
    raise exception 'An existing account received a pending email invitation';
  end if;

  -- Requesting a sign-in link creates an unconfirmed account; it stays invitable,
  -- including after its pending invitation was cancelled.
  perform public.invite_group_member_by_email(test_group_id, 'Unconfirmed@example.com');
  perform public.revoke_group_email_invite(test_group_id, 'unconfirmed@example.com');
  perform public.invite_group_member_by_email(test_group_id, 'unconfirmed@example.com');
  if (select count(*) from public.get_group_email_invites(test_group_id)
      where email = 'unconfirmed@example.com') <> 1 then
    raise exception 'An unconfirmed account could not be invited by email';
  end if;
end;
$$;

-- The invitation becomes a membership once that address is confirmed.
reset role;
update auth.users set email_confirmed_at = now()
  where id = '00000000-0000-0000-0000-000000000503';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000503', true);
do $$
begin
  if public.claim_group_invites() <> 1 then
    raise exception 'A confirmed address did not claim its email invitation';
  end if;
end;
$$;

rollback;
