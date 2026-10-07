begin;

-- Personal totals for the signed-in user's home page. Published results and
-- ballots are not readable by members directly, so this aggregate projection
-- returns only counts about the caller's own groups, entries, and ballots.
create function public.get_my_overview()
returns table (
  group_count integer,
  active_competition_count integer,
  entry_count integer,
  voted_entry_count integer,
  win_count integer,
  podium_count integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with my_groups as (
    select membership.group_id from public.group_members as membership
    where membership.user_id = (select auth.uid())
  ),
  my_entries as (
    select entry.id, entry.is_disqualified, competition.status
    from public.entries as entry
    join public.competitions as competition on competition.id = entry.competition_id
    join my_groups on my_groups.group_id = competition.group_id
    where entry.creator_id = (select auth.uid())
  ),
  my_results as (
    select result.rank
    from public.published_competition_results as result
    join my_entries on my_entries.id = result.entry_id
    where not my_entries.is_disqualified and my_entries.status = 'results_published'
  )
  select
    (select count(*)::integer from my_groups),
    (select count(*)::integer from public.competitions as competition
      join my_groups on my_groups.group_id = competition.group_id
      where competition.status in ('submission', 'voting')),
    (select count(*)::integer from my_entries),
    (select count(distinct vote.entry_id)::integer from public.votes as vote
      where vote.voter_id = (select auth.uid())),
    (select count(*)::integer from my_results where rank = 1),
    (select count(*)::integer from my_results where rank <= 3)
  where (select auth.uid()) is not null;
$$;

revoke all on function public.get_my_overview() from public, anon, authenticated, service_role;
grant execute on function public.get_my_overview() to authenticated;

-- What the caller still needs to do in each open competition of their groups,
-- mirroring the join, submission, and blind-voting rules: 'join' without a role,
-- 'submit' as a participant without an entry before the deadline, and 'vote'
-- while eligible and some other eligible entry has no score from the caller.
create function public.get_my_competition_actions()
returns table (competition_id uuid, action text)
language sql
stable
security definer
set search_path = ''
as $$
  select competition.id,
    case
      when participant.role is null then 'join'
      when competition.status = 'submission' then 'submit'
      else 'vote'
    end
  from public.competitions as competition
  join public.group_members as membership
    on membership.group_id = competition.group_id
   and membership.user_id = (select auth.uid())
  left join public.competition_participants as participant
    on participant.competition_id = competition.id
   and participant.user_id = (select auth.uid())
  where (
    competition.status = 'submission'
    and (participant.role is null or (
      participant.role = 'participant'
      and (competition.submission_deadline is null or clock_timestamp() < competition.submission_deadline)
      and not exists (
        select 1 from public.entries as entry
        where entry.competition_id = competition.id and entry.creator_id = (select auth.uid())
      )
    ))
  ) or (
    competition.status = 'voting'
    and (competition.voting_deadline is null or clock_timestamp() < competition.voting_deadline)
    and (participant.role is null or (
      (participant.role = 'audience'
        or (participant.role = 'participant' and competition.allow_participant_voting))
      and exists (
        select 1 from public.entries as entry
        where entry.competition_id = competition.id
          and entry.creator_id <> (select auth.uid())
          and not entry.is_disqualified
          and not exists (
            select 1 from public.votes as vote
            where vote.entry_id = entry.id and vote.voter_id = (select auth.uid())
          )
      )
    ))
  );
$$;

revoke all on function public.get_my_competition_actions() from public, anon, authenticated, service_role;
grant execute on function public.get_my_competition_actions() to authenticated;

commit;
