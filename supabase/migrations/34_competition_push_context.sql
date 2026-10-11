begin;

drop function public.claim_competition_push(uuid);

create function public.claim_competition_push(p_competition_id uuid)
returns table(id uuid, claim_token uuid, event_id uuid, phase text, locale text, subscription jsonb, competition_name text)
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
        jsonb_build_object('p256dh', subscription.p256dh, 'auth', subscription.auth)),
      competition.name
    from claimed join public.competition_push_events event on event.id = claimed.event_id
      join public.web_push_subscriptions subscription on subscription.id = claimed.subscription_id
      join public.competitions competition on competition.id = event.competition_id;
end;
$$;

revoke all on function public.claim_competition_push(uuid) from public, anon, authenticated, service_role;
grant execute on function public.claim_competition_push(uuid) to service_role;

commit;
