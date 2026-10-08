begin;

create or replace function public.can_read_submission_media(p_name text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.entries as entry
      join public.competitions as competition
        on competition.id = entry.competition_id
      join public.group_members as membership
        on membership.group_id = competition.group_id
      where (storage.foldername(p_name))[1] = competition.id::text
        and (storage.foldername(p_name))[2] = entry.id::text
        and membership.user_id = auth.uid()
        and not entry.content_removed
        and (
          membership.role = 'admin'
          or (
            competition.status = 'submission'
            and entry.creator_id = auth.uid()
          )
          or (
            competition.status = 'voting'
            and entry.creator_id = auth.uid()
            and p_name = any(entry.media_keys)
            and (competition.voting_deadline is null
              or clock_timestamp() < competition.voting_deadline)
          )
          or (
            competition.status = 'voting'
            and p_name = any(entry.media_keys)
            and entry.creator_id <> auth.uid()
            and not entry.is_disqualified
            and exists (
              select 1 from public.competition_participants as participant
              where participant.competition_id = competition.id
                and participant.user_id = auth.uid()
                and (participant.role = 'audience'
                  or (participant.role = 'participant' and competition.allow_participant_voting))
            )
            and (competition.voting_deadline is null
              or clock_timestamp() < competition.voting_deadline)
          )
          or (
            competition.status = 'results_published'
            and p_name = any(entry.media_keys)
            and exists (
              select 1
              from public.published_competition_results as result
              where result.competition_id = competition.id
                and result.entry_id = entry.id
                and not result.is_disqualified
            )
          )
        )
    );
$$;

revoke all on function public.can_read_submission_media(text)
  from public, anon, authenticated, service_role;
grant execute on function public.can_read_submission_media(text) to authenticated;

commit;
