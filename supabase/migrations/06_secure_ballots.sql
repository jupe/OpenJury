begin;

create or replace function public.cast_vote(
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
  target_creator_id uuid;
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

  select entry.id, entry.creator_id, category.max_score
    into target_entry_id, target_creator_id, target_max_score
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
  if target_creator_id = actor then
    raise exception 'Self-voting is not permitted' using errcode = '22023';
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

create function public.save_ballot(
  p_competition_id uuid,
  p_entry_number bigint,
  p_scores jsonb
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
  target_creator_id uuid;
  ballot_item jsonb;
  target_category_id uuid;
  target_max_score integer;
  ballot_score integer;
  score_count integer;
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

  select entry.id, entry.creator_id
    into target_entry_id, target_creator_id
    from public.entries as entry
    where entry.competition_id = p_competition_id
      and entry.random_number = p_entry_number
      and not entry.is_disqualified;

  if not found then
    raise exception 'Entry is not available for voting' using errcode = '22023';
  end if;
  if target_creator_id = actor then
    raise exception 'Self-voting is not permitted' using errcode = '22023';
  end if;
  if p_scores is null or jsonb_typeof(p_scores) is distinct from 'array' then
    raise exception 'A score is required for each category' using errcode = '22023';
  end if;

  score_count := jsonb_array_length(p_scores);
  if score_count = 0 or score_count <> (
    select count(*) from public.categories as category
    where category.competition_id = p_competition_id
  ) then
    raise exception 'A score is required for each category' using errcode = '22023';
  end if;

  for ballot_item in
    select item.value from jsonb_array_elements(p_scores) as item(value)
  loop
    if jsonb_typeof(ballot_item) is distinct from 'object'
       or ballot_item ->> 'category_id' is null
       or (ballot_item ->> 'category_id') !~
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(ballot_item -> 'score') is distinct from 'number'
       or (ballot_item ->> 'score') !~ '^[1-5]$' then
      raise exception 'Ballot category or score is invalid' using errcode = '22023';
    end if;

    target_category_id := (ballot_item ->> 'category_id')::uuid;
    ballot_score := (ballot_item ->> 'score')::integer;

    select category.max_score into target_max_score
      from public.categories as category
      where category.id = target_category_id
        and category.competition_id = p_competition_id;
    if not found or ballot_score > target_max_score then
      raise exception 'Ballot category or score is invalid' using errcode = '22023';
    end if;
  end loop;

  if (
    select count(distinct (item.value ->> 'category_id'))
    from jsonb_array_elements(p_scores) as item(value)
  ) <> score_count then
    raise exception 'Each category must have exactly one score' using errcode = '22023';
  end if;

  insert into public.votes (entry_id, voter_id, category_id, score)
  select target_entry_id, actor, (item.value ->> 'category_id')::uuid,
         (item.value ->> 'score')::integer
  from jsonb_array_elements(p_scores) as item(value)
  on conflict (entry_id, voter_id, category_id)
  do update set score = excluded.score;
end;
$$;

create function public.get_my_ballot(p_competition_id uuid)
returns table (entry_number bigint, category_id uuid, score integer)
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
  ) then
    raise exception 'Competition not found or access denied'
      using errcode = '42501';
  end if;

  return query
    select entry.random_number::bigint, vote.category_id, vote.score
    from public.votes as vote
    join public.entries as entry on entry.id = vote.entry_id
    where entry.competition_id = p_competition_id
      and vote.voter_id = actor
      and not entry.is_disqualified
    order by entry.random_number, vote.category_id;
end;
$$;

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
      and entry.creator_id <> actor
      and not entry.is_disqualified
    order by entry.random_number, entry.id;
end;
$$;

revoke all on function public.cast_vote(uuid, bigint, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.cast_vote(uuid, bigint, uuid, integer)
  to authenticated;
revoke all on function public.save_ballot(uuid, bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.save_ballot(uuid, bigint, jsonb)
  to authenticated;
revoke all on function public.get_my_ballot(uuid)
  from public, anon, authenticated;
grant execute on function public.get_my_ballot(uuid)
  to authenticated;
revoke all on function public.get_blind_voting_entries(uuid)
  from public, anon, authenticated;
grant execute on function public.get_blind_voting_entries(uuid)
  to authenticated;

commit;
