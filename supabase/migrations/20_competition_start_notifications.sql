begin;

create table public.competition_start_email_outbox (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  started_by uuid not null references auth.users(id),
  email text not null,
  competition_name text not null,
  group_name text not null,
  payload jsonb,
  first_attempt_at timestamptz,
  claim_token uuid,
  claimed_until timestamptz,
  sent_at timestamptz,
  unique (competition_id, user_id)
);
alter table public.competition_start_email_outbox enable row level security;
revoke all on public.competition_start_email_outbox from public, anon, authenticated, service_role;

create function public.start_competition(p_competition_id uuid, p_notify boolean default false)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target public.competitions;
begin
  select * into target from public.competitions
    where id = p_competition_id for update;
  if actor is null or not found or not exists (
    select 1 from public.group_members
    where group_id = target.group_id and user_id = actor and role = 'admin'
  ) then
    raise exception 'Competition administrator access required' using errcode = '42501';
  end if;

  if target.status <> 'draft' then
    if p_notify is true and exists (
      select 1 from public.competition_start_email_outbox
      where competition_id = target.id and started_by = actor
    ) then
      return target.status;
    end if;
    raise exception 'Competition already started without notifications or by another administrator'
      using errcode = '55000';
  end if;

  perform public.transition_competition(target.id, 'submission');
  if p_notify is true then
    insert into public.competition_start_email_outbox
      (competition_id, user_id, started_by, email, competition_name, group_name)
    select target.id, membership.user_id, actor, account.email, target.name, community.name
    from public.group_members membership
    join auth.users account on account.id = membership.user_id
    join public.groups community on community.id = membership.group_id
    where membership.group_id = target.group_id
      and account.email is not null and btrim(account.email) <> '';
  end if;
  return 'submission';
end;
$$;
revoke all on function public.start_competition(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.start_competition(uuid, boolean) to authenticated;

-- Only trusted server callers can claim addresses or acknowledge delivery.
create function public.claim_competition_start_email(
  p_competition_id uuid, p_from text, p_origin text
)
returns table (id uuid, claim_token uuid, payload jsonb)
language plpgsql security definer set search_path = ''
as $$
begin
  return query
  with candidate as (
    select email.id from public.competition_start_email_outbox email
    where email.competition_id = p_competition_id and email.sent_at is null
      and (email.claimed_until is null or email.claimed_until < clock_timestamp())
      -- Resend retains idempotency keys for 24 hours. Fail closed before expiry.
      and (email.first_attempt_at is null
        or email.first_attempt_at > clock_timestamp() - interval '23 hours')
    order by email.id limit 1 for update skip locked
  )
  update public.competition_start_email_outbox email
    set claim_token = gen_random_uuid(),
        claimed_until = clock_timestamp() + interval '2 minutes',
        first_attempt_at = coalesce(email.first_attempt_at, clock_timestamp()),
        payload = coalesce(email.payload, jsonb_build_object(
          'from', p_from,
          'to', jsonb_build_array(email.email),
          'subject', 'Competition started: ' || regexp_replace(email.competition_name, E'[\\r\\n]+', ' ', 'g'),
          'text', 'The competition "' || email.competition_name || '" in "' || email.group_name
            || E'" has started. Submissions are now open.\n\n'
            || p_origin || '/competition/' || email.competition_id::text
        ))
    from candidate where email.id = candidate.id
    returning email.id, email.claim_token, email.payload;
end;
$$;

create function public.finish_competition_start_email(
  p_id uuid, p_claim_token uuid, p_sent boolean
)
returns void
language sql security definer set search_path = ''
as $$
  update public.competition_start_email_outbox
    set sent_at = case when p_sent then clock_timestamp() else sent_at end,
        claimed_until = null, claim_token = null
    where id = p_id and claim_token = p_claim_token and sent_at is null;
$$;

create function public.competition_start_emails_sent(p_competition_id uuid)
returns boolean
language sql security definer set search_path = ''
as $$
  select not exists (
    select 1 from public.competition_start_email_outbox
    where competition_id = p_competition_id and sent_at is null
  );
$$;

revoke all on function public.claim_competition_start_email(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.finish_competition_start_email(uuid, uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.competition_start_emails_sent(uuid) from public, anon, authenticated, service_role;
grant execute on function public.claim_competition_start_email(uuid, text, text) to service_role;
grant execute on function public.finish_competition_start_email(uuid, uuid, boolean) to service_role;
grant execute on function public.competition_start_emails_sent(uuid) to service_role;

commit;
