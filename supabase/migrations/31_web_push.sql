begin;

create function public.valid_push_key(p_value text, p_bytes integer)
returns boolean language plpgsql immutable set search_path = ''
as $$
declare decoded bytea;
begin
  if p_value is null or p_value !~ '^[A-Za-z0-9_-]+$' or length(p_value) > 100 then return false; end if;
  decoded := decode(translate(p_value, '-_', '+/') || repeat('=', (4 - length(p_value) % 4) % 4), 'base64');
  return octet_length(decoded) = p_bytes
    and rtrim(replace(translate(encode(decoded, 'base64'), '+/', '-_'), E'\n', ''), '=') = p_value
    and (p_bytes <> 65 or get_byte(decoded, 0) = 4);
exception when others then return false;
end;
$$;

create table public.web_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  locale text not null check (locale in ('en', 'fi')),
  revision uuid not null default gen_random_uuid(),
  check (length(endpoint) <= 2048 and endpoint ~ '^https://([a-z0-9-]+\.)+push\.apple\.com/[^[:space:]\\#]+$'),
  check (public.valid_push_key(p256dh, 65)),
  check (public.valid_push_key(auth, 16))
);
create index web_push_subscriptions_user_idx on public.web_push_subscriptions(user_id);

create table public.competition_push_events (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  phase text not null check (phase in ('submission', 'voting', 'results_published')),
  created_at timestamptz not null default now()
);
create table public.competition_push_outbox (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.competition_push_events(id) on delete cascade,
  subscription_id uuid not null references public.web_push_subscriptions(id) on delete cascade,
  claim_token uuid,
  claimed_until timestamptz,
  claimed_revision uuid,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (event_id, subscription_id)
);
create index competition_push_events_competition_idx on public.competition_push_events(competition_id);
create index competition_push_outbox_pending_idx on public.competition_push_outbox(event_id, next_attempt_at)
  where finished_at is null;
alter table public.web_push_subscriptions enable row level security;
alter table public.competition_push_events enable row level security;
alter table public.competition_push_outbox enable row level security;
revoke all on public.web_push_subscriptions, public.competition_push_events, public.competition_push_outbox
  from public, anon, authenticated, service_role;

create function public.save_my_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_locale text)
returns void language plpgsql security definer set search_path = ''
as $$
declare actor uuid := auth.uid();
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_endpoint is null or length(p_endpoint) > 2048
    or p_endpoint !~ '^https://([a-z0-9-]+\.)+push\.apple\.com/[^[:space:]\\#]+$'
    or not public.valid_push_key(p_p256dh, 65)
    or not public.valid_push_key(p_auth, 16)
    or p_locale is null or p_locale not in ('en', 'fi') then
    raise exception 'Invalid subscription' using errcode = '22023';
  end if;
  -- Serialize even concurrent registrations for this user; no cap race.
  perform 1 from auth.users where id = actor for update;
  if exists (select 1 from public.web_push_subscriptions where endpoint = p_endpoint and user_id <> actor) then
    raise exception 'Endpoint unavailable' using errcode = '23505';
  end if;
  if not exists (select 1 from public.web_push_subscriptions where endpoint = p_endpoint and user_id = actor)
    and (select count(*) from public.web_push_subscriptions where user_id = actor) >= 5 then
    raise exception 'Subscription limit reached' using errcode = '54000';
  end if;
  insert into public.web_push_subscriptions(user_id, endpoint, p256dh, auth, locale)
    values (actor, p_endpoint, p_p256dh, p_auth, p_locale)
    on conflict (endpoint) do update
      set p256dh = excluded.p256dh, auth = excluded.auth, locale = excluded.locale,
        revision = gen_random_uuid()
      where public.web_push_subscriptions.user_id = actor;
  if not found then
    raise exception 'Endpoint unavailable' using errcode = '23505';
  end if;
end;
$$;

create function public.delete_my_push_subscription(p_endpoint text)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  delete from public.web_push_subscriptions where user_id = auth.uid() and endpoint = p_endpoint;
end;
$$;

create function public.queue_competition_push()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare event uuid;
begin
  if new.status is distinct from old.status then
    -- Retire even leased work before opening a new occurrence of a phase.
    update public.competition_push_outbox outbox
      set finished_at = clock_timestamp(), claim_token = null, claimed_until = null
      from public.competition_push_events event
      where outbox.event_id = event.id and event.competition_id = new.id
        and outbox.finished_at is null;
  end if;
  if new.status is distinct from old.status and new.status in ('submission', 'voting', 'results_published') then
    insert into public.competition_push_events(competition_id, phase)
      values (new.id, new.status)
      returning id into event;
    insert into public.competition_push_outbox(event_id, subscription_id)
      select event, subscription.id from public.web_push_subscriptions subscription
      join public.group_members member on member.user_id = subscription.user_id
      where member.group_id = new.group_id;
  end if;
  return new;
end;
$$;
create trigger competition_web_push_phase after update of status on public.competitions
  for each row execute function public.queue_competition_push();

create function public.authorize_competition_push(p_competition_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.competitions competition
    join public.group_members member on member.group_id = competition.group_id
    where competition.id = p_competition_id and member.user_id = auth.uid() and member.role = 'admin'
  ) then
    raise exception 'Competition administrator access required' using errcode = '42501';
  end if;
end;
$$;

create function public.claim_competition_push(p_competition_id uuid)
returns table(id uuid, claim_token uuid, event_id uuid, phase text, locale text, subscription jsonb)
language plpgsql security definer set search_path = ''
as $$
begin
  -- Revoked memberships must not hold a queue pending or reveal addresses.
  update public.competition_push_outbox outbox set finished_at = clock_timestamp(),
    claim_token = null, claimed_until = null
    from public.competition_push_events event, public.competitions competition,
      public.web_push_subscriptions subscription
    where outbox.event_id = event.id and event.competition_id = competition.id
      and competition.id = p_competition_id and subscription.id = outbox.subscription_id
      and outbox.finished_at is null and (competition.status <> event.phase or not exists (
        select 1 from public.group_members member
        where member.group_id = competition.group_id and member.user_id = subscription.user_id
      ));
  return query
    with candidate as (
      select outbox.id from public.competition_push_outbox outbox
      join public.competition_push_events event on event.id = outbox.event_id
      join public.competitions competition on competition.id = event.competition_id
      where event.competition_id = p_competition_id and competition.status = event.phase
        and outbox.finished_at is null
        and outbox.next_attempt_at <= clock_timestamp()
        and (outbox.claimed_until is null or outbox.claimed_until < clock_timestamp())
      order by event.created_at, outbox.id limit 1 for update of outbox skip locked
    ), claimed as (
      update public.competition_push_outbox outbox
        set claim_token = gen_random_uuid(), claimed_until = clock_timestamp() + interval '2 minutes',
          attempts = least(outbox.attempts + 1, 100),
          claimed_revision = subscription.revision
        from candidate, public.web_push_subscriptions subscription
        where outbox.id = candidate.id and subscription.id = outbox.subscription_id
        returning outbox.*
    )
    select claimed.id, claimed.claim_token, event.id, event.phase, subscription.locale,
      jsonb_build_object('endpoint', subscription.endpoint, 'keys',
        jsonb_build_object('p256dh', subscription.p256dh, 'auth', subscription.auth))
    from claimed join public.competition_push_events event on event.id = claimed.event_id
      join public.web_push_subscriptions subscription on subscription.id = claimed.subscription_id;
end;
$$;

create function public.get_my_pending_competition_push(p_competition_id uuid)
returns boolean language plpgsql security definer set search_path = ''
as $$
begin
  perform public.authorize_competition_push(p_competition_id);
  return exists (
    select 1 from public.competition_push_outbox outbox
    join public.competition_push_events event on event.id = outbox.event_id
    join public.competitions competition on competition.id = event.competition_id
    join public.web_push_subscriptions subscription on subscription.id = outbox.subscription_id
    join public.group_members member on member.group_id = competition.group_id and member.user_id = subscription.user_id
    where competition.id = p_competition_id and outbox.finished_at is null
  );
end;
$$;

create function public.competition_push_claim_active(p_id uuid, p_claim_token uuid)
returns boolean language sql security definer set search_path = ''
as $$
  select exists (
    select 1 from public.competition_push_outbox outbox
    join public.competition_push_events event on event.id = outbox.event_id
    join public.competitions competition on competition.id = event.competition_id
    join public.web_push_subscriptions subscription on subscription.id = outbox.subscription_id
    join public.group_members member on member.group_id = competition.group_id and member.user_id = subscription.user_id
    where outbox.id = p_id and outbox.claim_token = p_claim_token and outbox.finished_at is null
      and competition.status = event.phase
      and subscription.revision = outbox.claimed_revision
      and outbox.claimed_until > clock_timestamp()
  );
$$;

create function public.finish_competition_push(p_id uuid, p_claim_token uuid, p_outcome text)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare target public.competition_push_outbox;
begin
  if p_outcome is null or p_outcome not in ('sent', 'expired', 'retry', 'skipped') then
    raise exception 'Invalid outcome' using errcode = '22023';
  end if;
  select * into target from public.competition_push_outbox
    where id = p_id and claim_token = p_claim_token and finished_at is null
      and claimed_until > clock_timestamp() for update;
  if not found then return false; end if;
  if p_outcome in ('sent', 'skipped') and exists (
    select 1 from public.web_push_subscriptions subscription
    join public.competition_push_events event on event.id = target.event_id
    join public.competitions competition on competition.id = event.competition_id
    join public.group_members member on member.group_id = competition.group_id and member.user_id = subscription.user_id
    where subscription.id = target.subscription_id
      and subscription.revision <> target.claimed_revision and competition.status = event.phase
  ) then
    -- Neither a stale pre-send snapshot nor an accepted old-key payload is final.
    p_outcome := 'retry';
  end if;
  if p_outcome = 'expired' then
    -- A stale 410 must never delete a concurrently refreshed subscription.
    delete from public.web_push_subscriptions
      where id = target.subscription_id and revision = target.claimed_revision;
    if found then return true; end if;
    p_outcome := 'retry';
  end if;
  update public.competition_push_outbox
    set finished_at = case when p_outcome in ('sent', 'skipped') then clock_timestamp() else null end,
      next_attempt_at = clock_timestamp() + make_interval(secs => least(3600, (30 * power(2, least(target.attempts - 1, 7)))::integer)),
      claimed_until = null, claim_token = null, claimed_revision = null
    where id = target.id;
  return true;
end;
$$;

create function public.competition_push_sent(p_competition_id uuid)
returns boolean language sql security definer set search_path = ''
as $$
  select not exists (
    select 1 from public.competition_push_outbox outbox
    join public.competition_push_events event on event.id = outbox.event_id
    join public.competitions competition on competition.id = event.competition_id
    join public.web_push_subscriptions subscription on subscription.id = outbox.subscription_id
    join public.group_members member on member.group_id = competition.group_id and member.user_id = subscription.user_id
    where competition.id = p_competition_id and outbox.finished_at is null
  );
$$;

create function public.pending_competition_push_dispatch()
returns table(competition_id uuid)
language sql security definer set search_path = ''
as $$
  select event.competition_id
  from public.competition_push_outbox outbox
  join public.competition_push_events event on event.id = outbox.event_id
  where outbox.finished_at is null
    and outbox.next_attempt_at <= clock_timestamp()
    and (outbox.claimed_until is null or outbox.claimed_until < clock_timestamp())
  group by event.competition_id
  order by min(outbox.next_attempt_at), event.competition_id
  limit 10;
$$;

create function public.all_competition_push_sent()
returns boolean language sql security definer set search_path = ''
as $$
  select not exists (
    select 1 from public.competition_push_outbox outbox
    join public.competition_push_events event on event.id = outbox.event_id
    join public.competitions competition on competition.id = event.competition_id
    join public.web_push_subscriptions subscription on subscription.id = outbox.subscription_id
    join public.group_members member on member.group_id = competition.group_id and member.user_id = subscription.user_id
    where outbox.finished_at is null
  );
$$;

revoke all on function public.save_my_push_subscription(text,text,text,text),
  public.delete_my_push_subscription(text), public.authorize_competition_push(uuid),
  public.get_my_pending_competition_push(uuid),
  public.queue_competition_push(), public.claim_competition_push(uuid),
  public.competition_push_claim_active(uuid,uuid), public.finish_competition_push(uuid,uuid,text),
  public.competition_push_sent(uuid), public.pending_competition_push_dispatch(),
  public.all_competition_push_sent(),
  public.valid_push_key(text,integer) from public, anon, authenticated, service_role;
grant execute on function public.save_my_push_subscription(text,text,text,text),
  public.delete_my_push_subscription(text), public.authorize_competition_push(uuid),
  public.get_my_pending_competition_push(uuid) to authenticated;
grant execute on function public.claim_competition_push(uuid), public.competition_push_claim_active(uuid,uuid),
  public.finish_competition_push(uuid,uuid,text), public.competition_push_sent(uuid),
  public.pending_competition_push_dispatch(), public.all_competition_push_sent() to service_role;

commit;
