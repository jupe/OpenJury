begin;

create function public.get_admin_competition_participation_progress(p_competition_id uuid)
returns table (
  joined_count integer,
  participant_count integer,
  submitted_count integer,
  complete_ballot_count integer,
  eligible_voter_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null or not exists (
    select 1
    from public.competitions as competition
    join public.group_members as membership
      on membership.group_id = competition.group_id
    where competition.id = p_competition_id
      and membership.user_id = actor
      and membership.role = 'admin'
  ) then
    raise exception 'Competition administrator access required'
      using errcode = '42501';
  end if;

  return query
    with target_competition as (
      select competition.id, competition.group_id, competition.allow_participant_voting
      from public.competitions as competition
      where competition.id = p_competition_id
    ),
    joined_participants as (
      select participant.user_id, participant.role, competition.allow_participant_voting
      from public.competition_participants as participant
      join target_competition as competition
        on competition.id = participant.competition_id
      join public.group_members as membership
        on membership.group_id = competition.group_id
       and membership.user_id = participant.user_id
      where participant.competition_id = p_competition_id
    ),
    eligible_voters as (
      select participant.user_id
      from joined_participants as participant
      where (
        participant.role = 'audience'
        or (participant.role = 'participant' and participant.allow_participant_voting)
      )
        and exists (
          select 1
          from public.entries as entry
          where entry.competition_id = p_competition_id
            and not entry.is_disqualified
            and entry.creator_id <> participant.user_id
        )
        and exists (
          select 1
          from public.categories as category
          where category.competition_id = p_competition_id
        )
    ),
    complete_voters as (
      select voter.user_id
      from eligible_voters as voter
      where not exists (
        select 1
        from public.entries as entry
        cross join public.categories as category
        where entry.competition_id = p_competition_id
          and not entry.is_disqualified
          and entry.creator_id <> voter.user_id
          and category.competition_id = p_competition_id
          and not exists (
            select 1
            from public.votes as vote
            where vote.entry_id = entry.id
              and vote.voter_id = voter.user_id
              and vote.category_id = category.id
          )
      )
    )
    select
      (select count(*)::integer from joined_participants),
      (select count(*)::integer from joined_participants
        where role = 'participant'),
      (select count(*)::integer from joined_participants as participant
        where participant.role = 'participant'
          and exists (
            select 1
            from public.entries as entry
            where entry.competition_id = p_competition_id
              and entry.creator_id = participant.user_id
          )),
      (select count(*)::integer from complete_voters),
      (select count(*)::integer from eligible_voters);
end;
$$;

revoke all on function public.get_admin_competition_participation_progress(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_admin_competition_participation_progress(uuid)
  to authenticated;

commit;
