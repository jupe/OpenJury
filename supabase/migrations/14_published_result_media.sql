begin;

-- Published results show each ranked entry's images, so group members can
-- browse the winning entries. Disqualified entries stay without images.

drop function public.get_published_competition_results(uuid);

create function public.get_published_competition_results(p_competition_id uuid)
returns table (
  rank integer,
  score numeric,
  vote_count integer,
  title text,
  creator_id uuid,
  creator_name text,
  is_disqualified boolean,
  media_keys text[]
)
language plpgsql
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
      and competition.status = 'results_published'
  ) then
    raise exception 'Published results are not available'
      using errcode = '42501';
  end if;

  return query
    select result.rank, result.score, result.vote_count,
           coalesce(result.title, entry.title), coalesce(result.creator_id, entry.creator_id),
           coalesce(
             nullif(btrim(account.raw_user_meta_data ->> 'display_name'), ''),
             nullif(btrim(account.raw_user_meta_data ->> 'full_name'), ''),
             nullif(btrim(account.raw_user_meta_data ->> 'name'), ''),
             'Participant'
           ),
           result.is_disqualified,
           case
             when result.is_disqualified or entry.content_removed then '{}'::text[]
             else entry.media_keys
           end
    from public.published_competition_results as result
    join public.entries as entry on entry.id = result.entry_id
    left join auth.users as account
      on account.id = coalesce(result.creator_id, entry.creator_id)
    where result.competition_id = p_competition_id
    order by result.rank, result.entry_id;
end;
$$;

revoke all on function public.get_published_competition_results(uuid)
  from public, anon, authenticated;
grant execute on function public.get_published_competition_results(uuid)
  to authenticated;

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
            and p_name = any(entry.media_keys)
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
  from public, anon, authenticated;
grant execute on function public.can_read_submission_media(text) to authenticated;

commit;
