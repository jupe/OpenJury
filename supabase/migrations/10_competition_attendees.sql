begin;

create function public.get_admin_competition_attendees(p_competition_id uuid)
returns table (
  user_id uuid,
  display_name text,
  role text,
  has_submission boolean,
  has_voted boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_group_id uuid;
begin
  select competition.group_id into target_group_id
  from public.competitions as competition
  join public.group_members as membership
    on membership.group_id = competition.group_id
  where competition.id = p_competition_id
    and membership.user_id = actor
    and membership.role = 'admin';

  if actor is null or not found then
    raise exception 'Competition administrator access required'
      using errcode = '42501';
  end if;

  return query
    with competition_creators as (
      select entry.creator_id as user_id
      from public.entries as entry
      where entry.competition_id = p_competition_id
    ),
    competition_voters as (
      select distinct vote.voter_id as user_id
      from public.votes as vote
      join public.entries as entry on entry.id = vote.entry_id
      where entry.competition_id = p_competition_id
    ),
    attendees as (
      select membership.user_id
      from public.group_members as membership
      where membership.group_id = target_group_id
      union
      select creator.user_id from competition_creators as creator
      union
      select voter.user_id from competition_voters as voter
    )
    select attendee.user_id,
           coalesce(
             nullif(btrim(account.raw_user_meta_data ->> 'display_name'), ''),
             nullif(btrim(account.raw_user_meta_data ->> 'full_name'), ''),
             nullif(btrim(account.raw_user_meta_data ->> 'name'), ''),
             nullif(btrim(account.email), ''),
             'Participant'
           ),
           coalesce(membership.role, 'former member'),
           exists (
             select 1 from competition_creators as creator
             where creator.user_id = attendee.user_id
           ),
           exists (
             select 1 from competition_voters as voter
             where voter.user_id = attendee.user_id
           )
    from attendees as attendee
    join auth.users as account on account.id = attendee.user_id
    left join public.group_members as membership
      on membership.group_id = target_group_id
     and membership.user_id = attendee.user_id
    order by attendee.user_id;
end;
$$;

drop function public.get_published_competition_results(uuid);

create function public.get_published_competition_results(p_competition_id uuid)
returns table (
  rank integer,
  score numeric,
  vote_count integer,
  title text,
  creator_id uuid,
  creator_name text
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
      and competition.status = 'completed'
  ) then
    raise exception 'Published results are not available'
      using errcode = '42501';
  end if;

  return query
    select result.rank, result.score, result.vote_count, entry.title, entry.creator_id,
           coalesce(
             nullif(btrim(account.raw_user_meta_data ->> 'display_name'), ''),
             nullif(btrim(account.raw_user_meta_data ->> 'full_name'), ''),
             nullif(btrim(account.raw_user_meta_data ->> 'name'), ''),
             'Participant'
           )
    from public.published_competition_results as result
    join public.entries as entry on entry.id = result.entry_id
    left join auth.users as account on account.id = entry.creator_id
    where result.competition_id = p_competition_id
    order by result.rank, entry.id;
end;
$$;

revoke all on function public.get_admin_competition_attendees(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_admin_competition_attendees(uuid) to authenticated;
revoke all on function public.get_published_competition_results(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_published_competition_results(uuid) to authenticated;

commit;
