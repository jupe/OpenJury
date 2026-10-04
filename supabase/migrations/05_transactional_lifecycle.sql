begin;

create function public.assign_competition_entry_numbers(p_competition_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.entries
    set random_number = null
    where competition_id = p_competition_id;

  with shuffled_entries as (
    select entry.id,
           row_number() over (order by gen_random_uuid())::integer as entry_number
    from public.entries as entry
    where entry.competition_id = p_competition_id
  )
  update public.entries as entry
    set random_number = shuffled_entries.entry_number
    from shuffled_entries
    where entry.id = shuffled_entries.id;
end;
$$;

revoke all on function public.assign_competition_entry_numbers(uuid)
  from public, anon, authenticated;

create function public.transition_competition(
  p_competition_id uuid,
  p_target_status text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_group_id uuid;
  current_status text;
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select competition.group_id, competition.status
    into target_group_id, current_status
    from public.competitions as competition
    where competition.id = p_competition_id
    for update;

  if not found or not exists (
    select 1 from public.group_members as membership
    where membership.group_id = target_group_id
      and membership.user_id = actor
      and membership.role = 'admin'
  ) then
    raise exception 'Competition administrator access required'
      using errcode = '42501';
  end if;

  if p_target_status is null or not (
    (current_status = 'draft' and p_target_status = 'submission')
    or (current_status = 'submission' and p_target_status = 'voting')
    or (current_status = 'voting' and p_target_status = 'review_pending')
    or (current_status = 'review_pending' and p_target_status = 'completed')
  ) then
    raise exception 'Invalid competition status transition'
      using errcode = '55000';
  end if;

  if p_target_status = 'voting' then
    perform public.assign_competition_entry_numbers(p_competition_id);
  end if;

  update public.competitions
    set status = p_target_status
    where id = p_competition_id;

  return p_target_status;
end;
$$;

revoke all on function public.transition_competition(uuid, text)
  from public, anon, authenticated;
grant execute on function public.transition_competition(uuid, text)
  to authenticated;

create function public.cast_vote(
  p_competition_id uuid,
  p_entry_number bigint,
  p_category_id uuid,
  p_score integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_status text;
  target_deadline timestamptz;
  target_entry_id uuid;
  target_max_score integer;
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select competition.status, competition.voting_deadline
    into target_status, target_deadline
    from public.competitions as competition
    where competition.id = p_competition_id
    for update;

  if not found or not exists (
    select 1
    from public.competitions as competition
    join public.group_members as membership
      on membership.group_id = competition.group_id
    where competition.id = p_competition_id
      and membership.user_id = actor
  ) then
    raise exception 'Competition not found or access denied'
      using errcode = '42501';
  end if;

  if target_status <> 'voting'
     or (target_deadline is not null and clock_timestamp() >= target_deadline) then
    raise exception 'Voting is not open' using errcode = '55000';
  end if;

  if p_score is null or p_score not between 1 and 5 then
    raise exception 'Vote score must be from 1 to 5' using errcode = '22023';
  end if;

  select entry.id, category.max_score
    into target_entry_id, target_max_score
    from public.entries as entry
    join public.categories as category
      on category.competition_id = entry.competition_id
    where entry.competition_id = p_competition_id
      and entry.random_number = p_entry_number
      and not entry.is_disqualified
      and category.id = p_category_id;

  if not found or target_entry_id is null then
    raise exception 'Entry or category is not available for voting'
      using errcode = '22023';
  end if;
  if p_score > target_max_score then
    raise exception 'Vote score exceeds the category maximum'
      using errcode = '22023';
  end if;

  insert into public.votes (entry_id, voter_id, category_id, score)
  values (target_entry_id, actor, p_category_id, p_score)
  on conflict (entry_id, voter_id, category_id)
  do update set score = excluded.score;
end;
$$;

revoke all on function public.cast_vote(uuid, bigint, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.cast_vote(uuid, bigint, uuid, integer)
  to authenticated;

create or replace function public.get_blind_voting_entries(p_competition_id uuid)
returns table (entry_number bigint, media_keys text[])
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
      and competition.status = 'voting'
      and (competition.voting_deadline is null
        or clock_timestamp() < competition.voting_deadline)
  ) then
    raise exception 'Blind voting is not available' using errcode = '42501';
  end if;

  return query
    select entry.random_number::bigint, entry.media_keys
    from public.entries as entry
    where entry.competition_id = p_competition_id
      and not entry.is_disqualified
    order by entry.random_number, entry.id;
end;
$$;

create function public.process_remote_competition_deadlines()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  target record;
  processed_count integer := 0;
  processing_time timestamptz := clock_timestamp();
begin
  for target in
    select competition.id, competition.status
    from public.competitions as competition
    where competition.event_type = 'remote'
      and (
        (competition.status = 'submission'
          and competition.submission_deadline is not null
          and competition.submission_deadline <= processing_time)
        or
        (competition.status = 'voting'
          and competition.voting_deadline is not null
          and competition.voting_deadline <= processing_time)
      )
    order by competition.id
    for update of competition skip locked
  loop
    if target.status = 'submission' then
      perform public.assign_competition_entry_numbers(target.id);
      update public.competitions
        set status = 'voting'
        where id = target.id and status = 'submission';
    else
      update public.competitions
        set status = 'review_pending'
        where id = target.id and status = 'voting';
    end if;
    processed_count := processed_count + 1;
  end loop;

  return processed_count;
end;
$$;

revoke all on function public.process_remote_competition_deadlines()
  from public, anon, authenticated;
grant execute on function public.process_remote_competition_deadlines()
  to service_role;

commit;
