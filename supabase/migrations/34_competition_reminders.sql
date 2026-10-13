begin;

alter table public.competition_push_events
  add column kind text not null default 'phase' check (kind in ('phase', 'reminder')),
  add column reminder_actor_id uuid references auth.users(id) on delete set null;

-- Manual sends, not delivery attempts or automatic phase events, consume these limits.
-- Keep group history even if its competition is deleted.
create table public.competition_reminder_history (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid references public.competitions(id) on delete set null,
  group_id uuid not null references public.groups(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp()
);
create index competition_reminder_history_competition_idx
  on public.competition_reminder_history(competition_id, created_at desc);
create index competition_reminder_history_group_idx
  on public.competition_reminder_history(group_id, created_at desc);
alter table public.competition_reminder_history enable row level security;
revoke all on public.competition_reminder_history from public, anon, authenticated, service_role;

create function public.competition_reminder_recipient(
  p_competition_id uuid, p_user_id uuid, p_actor_id uuid
)
returns boolean language sql security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.competitions competition
    join public.group_members member on member.group_id = competition.group_id
    left join public.competition_participants participant
      on participant.competition_id = competition.id and participant.user_id = member.user_id
    where competition.id = p_competition_id and member.user_id = p_user_id
      and member.user_id is distinct from p_actor_id
      and (
        competition.status = 'results_published'
        or (
          competition.status = 'submission'
          and (competition.submission_deadline > clock_timestamp()
            or (competition.event_type = 'live' and competition.submission_deadline is null))
          and (participant.user_id is null or (
            participant.role = 'participant' and not exists (
              select 1 from public.entries entry
              where entry.competition_id = competition.id and entry.creator_id = member.user_id
            )
          ))
        )
        or (
          competition.status = 'voting'
          and (competition.voting_deadline > clock_timestamp()
            or (competition.event_type = 'live' and competition.voting_deadline is null))
          and (participant.role = 'audience'
            or (participant.role = 'participant' and competition.allow_participant_voting))
          and exists (
            select 1 from public.entries entry
            where entry.competition_id = competition.id and not entry.is_disqualified
              and entry.creator_id <> member.user_id
          )
          and exists (
            select 1 from public.categories category where category.competition_id = competition.id
          )
          and exists (
            select 1 from public.entries entry
            cross join public.categories category
            where entry.competition_id = competition.id and not entry.is_disqualified
              and entry.creator_id <> member.user_id and category.competition_id = competition.id
              and not exists (
                select 1 from public.votes vote
                where vote.entry_id = entry.id and vote.voter_id = member.user_id
                  and vote.category_id = category.id
              )
          )
        )
      )
  );
$$;

create function public.competition_reminder_next_allowed(p_competition_id uuid, p_group_id uuid)
returns timestamptz language sql security definer set search_path = ''
as $$
  select greatest(
    (select max(history.created_at) + interval '1 hour'
      from public.competition_reminder_history history
      where history.competition_id = p_competition_id
        and history.created_at > clock_timestamp() - interval '1 hour'),
    (select history.created_at + interval '24 hours'
      from public.competition_reminder_history history
      where history.competition_id = p_competition_id
        and history.created_at > clock_timestamp() - interval '24 hours'
      order by history.created_at desc offset 2 limit 1),
    (select max(history.created_at) + interval '15 minutes'
      from public.competition_reminder_history history
      where history.group_id = p_group_id
        and history.created_at > clock_timestamp() - interval '15 minutes')
  );
$$;

create function public.get_competition_reminder_status(p_competition_id uuid)
returns table(phase text, recipient_count integer, next_allowed_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare target public.competitions;
begin
  perform public.authorize_competition_push(p_competition_id);
  select * into target from public.competitions where id = p_competition_id;
  if target.status not in ('submission', 'voting', 'results_published') then
    return query select null::text, 0, null::timestamptz;
    return;
  end if;
  if (target.status = 'submission' and
      (target.submission_deadline <= clock_timestamp()
        or (target.event_type = 'remote' and target.submission_deadline is null)))
    or (target.status = 'voting' and
      (target.voting_deadline <= clock_timestamp()
        or (target.event_type = 'remote' and target.voting_deadline is null))) then
    return query select null::text, 0, null::timestamptz;
    return;
  end if;
  return query select target.status,
    (select count(distinct subscription.user_id)::integer
      from public.web_push_subscriptions subscription
      where public.competition_reminder_recipient(target.id, subscription.user_id, auth.uid())),
    public.competition_reminder_next_allowed(target.id, target.group_id);
end;
$$;

create function public.queue_competition_reminder(p_competition_id uuid)
returns table(phase text, recipient_count integer, next_allowed_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare
  target public.competitions;
  target_group uuid;
  reminder_event uuid;
  status record;
  queued_count integer;
begin
  perform public.authorize_competition_push(p_competition_id);
  select competition.group_id into target_group from public.competitions competition
    where competition.id = p_competition_id;
  -- All competitions and admins in a group share one serialization point.
  perform 1 from public.groups where id = target_group for update;
  select * into target from public.competitions where id = p_competition_id for update;
  if not found or target.group_id is distinct from target_group then
    raise exception 'Competition changed while queuing reminder' using errcode = '40001';
  end if;
  select * into status from public.get_competition_reminder_status(p_competition_id);
  if status.phase is null then
    raise exception 'Competition phase or deadline does not support reminders' using errcode = '22023';
  end if;
  if status.next_allowed_at > clock_timestamp() then
    raise exception 'Competition reminder cooldown active' using errcode = '54000';
  end if;
  if status.recipient_count = 0 then
    raise exception 'No eligible reminder recipients' using errcode = '22023';
  end if;
  insert into public.competition_push_events(competition_id, phase, kind, reminder_actor_id)
    values (target.id, target.status, 'reminder', auth.uid()) returning id into reminder_event;
  with queued as (
    insert into public.competition_push_outbox(event_id, subscription_id)
      select reminder_event, subscription.id from public.web_push_subscriptions subscription
      where public.competition_reminder_recipient(target.id, subscription.user_id, auth.uid())
      returning subscription_id
  )
  select count(distinct subscription.user_id)::integer into queued_count
    from queued join public.web_push_subscriptions subscription on subscription.id = queued.subscription_id;
  if queued_count > 0 then
    insert into public.competition_reminder_history(competition_id, group_id)
      values (target.id, target.group_id);
  else
    -- Raising rolls back the event as well as the failed queue attempt.
    raise exception 'No eligible reminder recipients' using errcode = '22023';
  end if;
  return query select target.status, queued_count,
    public.competition_reminder_next_allowed(target.id, target.group_id);
end;
$$;

drop function public.claim_competition_push(uuid);
create function public.claim_competition_push(p_competition_id uuid)
returns table(id uuid, claim_token uuid, event_id uuid, phase text, locale text,
  subscription jsonb, competition_name text, kind text)
language plpgsql security definer set search_path = ''
as $$
begin
  update public.competition_push_outbox outbox set finished_at = clock_timestamp(),
    claim_token = null, claimed_until = null
    from public.competition_push_events event, public.competitions competition,
      public.web_push_subscriptions subscription
    where outbox.event_id = event.id and event.competition_id = competition.id
      and competition.id = p_competition_id and subscription.id = outbox.subscription_id
      and outbox.finished_at is null and (
        competition.status <> event.phase or not exists (
          select 1 from public.group_members member
          where member.group_id = competition.group_id and member.user_id = subscription.user_id
        ) or (event.kind = 'reminder' and not public.competition_reminder_recipient(
          competition.id, subscription.user_id, event.reminder_actor_id))
      );
  return query
    with candidate as (
      select outbox.id from public.competition_push_outbox outbox
      join public.competition_push_events event on event.id = outbox.event_id
      join public.competitions competition on competition.id = event.competition_id
      join public.web_push_subscriptions subscription on subscription.id = outbox.subscription_id
      where event.competition_id = p_competition_id and competition.status = event.phase
        and outbox.finished_at is null
        and outbox.next_attempt_at <= clock_timestamp()
        and (outbox.claimed_until is null or outbox.claimed_until < clock_timestamp())
        and exists (
          select 1 from public.group_members member
          where member.group_id = competition.group_id and member.user_id = subscription.user_id
        )
        and (event.kind <> 'reminder' or public.competition_reminder_recipient(
          competition.id, subscription.user_id, event.reminder_actor_id))
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
        jsonb_build_object('p256dh', subscription.p256dh, 'auth', subscription.auth)),
      competition.name, event.kind
    from claimed join public.competition_push_events event on event.id = claimed.event_id
      join public.web_push_subscriptions subscription on subscription.id = claimed.subscription_id
      join public.competitions competition on competition.id = event.competition_id;
end;
$$;

create or replace function public.competition_push_claim_active(p_id uuid, p_claim_token uuid)
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
      and (event.kind <> 'reminder' or public.competition_reminder_recipient(
        competition.id, subscription.user_id, event.reminder_actor_id))
  );
$$;

revoke all on function public.competition_reminder_recipient(uuid,uuid,uuid),
  public.competition_reminder_next_allowed(uuid,uuid),
  public.get_competition_reminder_status(uuid), public.queue_competition_reminder(uuid),
  public.claim_competition_push(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_competition_reminder_status(uuid),
  public.queue_competition_reminder(uuid) to authenticated;
grant execute on function public.competition_reminder_recipient(uuid,uuid,uuid),
  public.claim_competition_push(uuid) to service_role;

commit;
