-- Run with psql as the database owner after all migrations; fixtures roll back.
begin;

do $$
begin
  if not (select relrowsecurity from pg_class
    where oid = 'public.competition_start_email_outbox'::regclass) then
    raise exception 'Outbox must use RLS';
  end if;
  if has_table_privilege('authenticated', 'public.competition_start_email_outbox', 'SELECT')
    or has_table_privilege('anon', 'public.competition_start_email_outbox', 'SELECT')
    or has_table_privilege('service_role', 'public.competition_start_email_outbox', 'UPDATE')
    or has_function_privilege('authenticated', 'public.claim_competition_start_email(uuid,text,text)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.finish_competition_start_email(uuid,uuid,boolean)', 'EXECUTE')
    or has_function_privilege('anon', 'public.start_competition(uuid,boolean)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.claim_competition_start_email(uuid,text,text)', 'EXECUTE') then
    raise exception 'Outbox privileges must be private with service-only delivery RPCs';
  end if;
end;
$$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000002001', 'starter@example.com'),
  ('00000000-0000-0000-0000-000000002002', 'member@example.com'),
  ('00000000-0000-0000-0000-000000002003', 'other-admin@example.com'),
  ('00000000-0000-0000-0000-000000002004', 'later@example.com'),
  ('00000000-0000-0000-0000-000000002005', null);
insert into public.groups (id, name, created_by) values
  ('00000000-0000-0000-0000-000000002010', 'Email tenant', '00000000-0000-0000-0000-000000002001');
insert into public.group_members (group_id, user_id, role) values
  ('00000000-0000-0000-0000-000000002010', '00000000-0000-0000-0000-000000002001', 'admin'),
  ('00000000-0000-0000-0000-000000002010', '00000000-0000-0000-0000-000000002002', 'member'),
  ('00000000-0000-0000-0000-000000002010', '00000000-0000-0000-0000-000000002003', 'admin'),
  ('00000000-0000-0000-0000-000000002010', '00000000-0000-0000-0000-000000002005', 'member');
insert into public.competitions (id, group_id, name, event_type) values
  ('00000000-0000-0000-0000-000000002020', '00000000-0000-0000-0000-000000002010', E'Bake-off\n<script>', 'live'),
  ('00000000-0000-0000-0000-000000002021', '00000000-0000-0000-0000-000000002010', 'Legacy skip', 'live'),
  ('00000000-0000-0000-0000-000000002022', '00000000-0000-0000-0000-000000002010', 'Default skip', 'live');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000002002', true);
do $$
begin
  begin
    perform public.start_competition('00000000-0000-0000-0000-000000002020', true);
    raise exception 'Member must not start competitions';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.claim_competition_start_email('00000000-0000-0000-0000-000000002020', 'jury@example.com', 'https://jury.example.com');
    raise exception 'Member must not read email claims';
  exception when insufficient_privilege then null;
  end;
end;
$$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000002001', true);
select public.start_competition('00000000-0000-0000-0000-000000002020', true);
select public.transition_competition('00000000-0000-0000-0000-000000002021', 'submission');
select public.start_competition('00000000-0000-0000-0000-000000002022');
reset role;

do $$
begin
  if (select count(*) from public.competition_start_email_outbox) <> 3 then
    raise exception 'Only opt-in must snapshot all members with email, including admins';
  end if;
  if exists (select 1 from public.competitions where id in (
    '00000000-0000-0000-0000-000000002020', '00000000-0000-0000-0000-000000002021',
    '00000000-0000-0000-0000-000000002022') and status <> 'submission') then
    raise exception 'Both skip paths and opt-in must open submissions';
  end if;
end;
$$;
insert into public.group_members (group_id, user_id, role) values
  ('00000000-0000-0000-0000-000000002010', '00000000-0000-0000-0000-000000002004', 'member');
update auth.users set email = 'changed@example.com'
  where id = '00000000-0000-0000-0000-000000002002';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000002001', true);
select public.start_competition('00000000-0000-0000-0000-000000002020', true);
do $$
begin
  begin
    perform public.start_competition('00000000-0000-0000-0000-000000002021', true);
    raise exception 'Skipped starts cannot acquire an outbox later';
  exception when sqlstate '55000' then null;
  end;
end;
$$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000002003', true);
do $$
begin
  begin
    perform public.start_competition('00000000-0000-0000-0000-000000002020', true);
    raise exception 'Only the starting administrator can retry';
  exception when sqlstate '55000' then null;
  end;
end;
$$;
reset role;
do $$
begin
  if (select count(*) from public.competition_start_email_outbox) <> 3
    or not exists (select 1 from public.competition_start_email_outbox
      where user_id = '00000000-0000-0000-0000-000000002002' and email = 'member@example.com') then
    raise exception 'Retry must not resnapshot memberships or email addresses';
  end if;
end;
$$;

set local role service_role;
do $$
declare
  first_claim record;
  second_claim record;
  retried record;
begin
  select * into first_claim from public.claim_competition_start_email(
    '00000000-0000-0000-0000-000000002020', 'jury@example.com', 'https://jury.example.com');
  select * into second_claim from public.claim_competition_start_email(
    '00000000-0000-0000-0000-000000002020', 'jury@example.com', 'https://jury.example.com');
  if first_claim.id is null or second_claim.id is null or first_claim.id = second_claim.id then
    raise exception 'Active leases must not be claimed again';
  end if;
  if first_claim.payload ? 'html' or first_claim.payload->>'subject' like E'%\n%'
    or first_claim.payload->>'text' not like '%https://jury.example.com/competition/00000000-0000-0000-0000-000000002020%' then
    raise exception 'Email must use plain text, a single-line subject and trusted direct link';
  end if;
  perform public.finish_competition_start_email(first_claim.id, gen_random_uuid(), true);
  perform public.finish_competition_start_email(first_claim.id, first_claim.claim_token, false);
  select * into retried from public.claim_competition_start_email(
    '00000000-0000-0000-0000-000000002020', 'changed@example.com', 'https://changed.example.com');
  if retried.id is distinct from first_claim.id or retried.claim_token = first_claim.claim_token
    or retried.payload is distinct from first_claim.payload then
    raise exception 'Failed delivery must retry the same immutable payload with a new lease';
  end if;
  perform public.finish_competition_start_email(retried.id, first_claim.claim_token, true);
  if public.competition_start_emails_sent('00000000-0000-0000-0000-000000002020') then
    raise exception 'Stale claim acknowledgements must not complete pending mail';
  end if;
  perform public.finish_competition_start_email(retried.id, retried.claim_token, true);
  perform public.finish_competition_start_email(second_claim.id, second_claim.claim_token, true);
end;
$$;
reset role;

-- Old ambiguous sends must fail closed after the provider's retention window.
update public.competition_start_email_outbox
  set first_attempt_at = clock_timestamp() - interval '25 hours', claimed_until = null, claim_token = null
  where sent_at is null;
set local role service_role;
do $$
begin
  if exists (select 1 from public.claim_competition_start_email(
    '00000000-0000-0000-0000-000000002020', 'jury@example.com', 'https://jury.example.com'))
    or public.competition_start_emails_sent('00000000-0000-0000-0000-000000002020') then
    raise exception 'Expired provider idempotency requires operator reconciliation, not resending';
  end if;
end;
$$;
reset role;
rollback;
