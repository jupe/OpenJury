begin;

create table public.entry_disqualification_events (
  id bigint generated always as identity primary key,
  entry_id uuid not null references public.entries(id),
  actor_id uuid not null references auth.users(id),
  reason text not null check (char_length(btrim(reason)) between 1 and 500),
  created_at timestamptz not null default clock_timestamp()
);

create index entry_disqualification_events_entry_id_idx
  on public.entry_disqualification_events (entry_id, created_at desc);

alter table public.entry_disqualification_events enable row level security;
revoke all on public.entry_disqualification_events from public, anon, authenticated;

create table public.published_competition_results (
  competition_id uuid not null references public.competitions(id) on delete cascade,
  entry_id uuid not null references public.entries(id) on delete cascade,
  rank integer not null check (rank > 0),
  score numeric(8, 4) not null,
  vote_count integer not null check (vote_count > 0),
  published_at timestamptz not null default clock_timestamp(),
  primary key (competition_id, entry_id)
);

create index published_competition_results_rank_idx
  on public.published_competition_results (competition_id, rank, entry_id);

alter table public.published_competition_results enable row level security;
revoke all on public.published_competition_results from public, anon, authenticated;

create or replace function public.transition_competition(
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

  if p_target_status = 'completed' then
    raise exception 'Results must be published to complete a competition'
      using errcode = '55000';
  end if;

  if p_target_status is null or not (
    (current_status = 'draft' and p_target_status = 'submission')
    or (current_status = 'submission' and p_target_status = 'voting')
    or (current_status = 'voting' and p_target_status = 'review_pending')
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

create function public.get_admin_review_results(p_competition_id uuid)
returns table (
  entry_id uuid,
  creator_id uuid,
  title text,
  is_disqualified boolean,
  rank integer,
  score numeric,
  vote_count integer,
  disqualification_reason text,
  disqualified_by uuid,
  disqualified_at timestamptz
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
      and membership.role = 'admin'
      and competition.status = 'review_pending'
  ) then
    raise exception 'Competition administrator review access required'
      using errcode = '42501';
  end if;

  return query
    with category_count as (
      select count(*)::integer as total
      from public.categories as category
      where category.competition_id = p_competition_id
    ),
    complete_ballots as (
      select vote.entry_id, vote.voter_id
      from public.votes as vote
      join public.entries as entry on entry.id = vote.entry_id
      join public.categories as category on category.id = vote.category_id
      where entry.competition_id = p_competition_id
        and not entry.is_disqualified
        and category.competition_id = p_competition_id
      group by vote.entry_id, vote.voter_id
      having count(distinct vote.category_id) = (select total from category_count)
    ),
    category_scores as (
      select vote.entry_id,
             vote.category_id,
             avg(vote.score::numeric / category.max_score * 100) as percentage
      from public.votes as vote
      join complete_ballots as ballot
        on ballot.entry_id = vote.entry_id and ballot.voter_id = vote.voter_id
      join public.categories as category
        on category.id = vote.category_id
       and category.competition_id = p_competition_id
      group by vote.entry_id, vote.category_id
    ),
    aggregates as (
      select category_score.entry_id,
             avg(category_score.percentage)::numeric(8, 4) as score,
             count(distinct ballot.voter_id)::integer as vote_count
      from category_scores as category_score
      join complete_ballots as ballot using (entry_id)
      group by category_score.entry_id
    ),
    ranked as (
      select aggregate.entry_id,
             rank() over (order by aggregate.score desc)::integer as entry_rank,
             aggregate.score,
             aggregate.vote_count
      from aggregates as aggregate
    )
    select entry.id,
           entry.creator_id,
           entry.title,
           entry.is_disqualified,
           case when entry.is_disqualified then null else ranked.entry_rank end,
           case when entry.is_disqualified then null else ranked.score end,
           case when entry.is_disqualified then 0 else coalesce(ranked.vote_count, 0) end,
           latest_event.reason,
           latest_event.actor_id,
           latest_event.created_at
    from public.entries as entry
    left join ranked on ranked.entry_id = entry.id
    left join lateral (
      select event.reason, event.actor_id, event.created_at
      from public.entry_disqualification_events as event
      where event.entry_id = entry.id
      order by event.created_at desc, event.id desc
      limit 1
    ) as latest_event on true
    where entry.competition_id = p_competition_id
    order by entry.is_disqualified, ranked.entry_rank nulls last, entry.id;
end;
$$;

create function public.disqualify_competition_entry(
  p_competition_id uuid,
  p_entry_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  normalized_reason text := btrim(p_reason);
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  perform 1
  from public.competitions as competition
  join public.group_members as membership
    on membership.group_id = competition.group_id
  where competition.id = p_competition_id
    and membership.user_id = actor
    and membership.role = 'admin'
    and competition.status = 'review_pending'
  for update of competition;

  if not found then
    raise exception 'Competition administrator review access required'
      using errcode = '42501';
  end if;

  if normalized_reason is null
     or char_length(normalized_reason) not between 1 and 500 then
    raise exception 'Disqualification reason must contain 1 to 500 characters'
      using errcode = '22023';
  end if;

  update public.entries
    set is_disqualified = true
    where id = p_entry_id
      and competition_id = p_competition_id
      and not is_disqualified;

  if not found then
    raise exception 'Entry not found or already disqualified'
      using errcode = '22023';
  end if;

  insert into public.entry_disqualification_events (entry_id, actor_id, reason)
  values (p_entry_id, actor, normalized_reason);
end;
$$;

create function public.publish_competition_results(p_competition_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  eligible_count integer;
  missing_ballots integer;
  published_count integer;
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  perform 1
  from public.competitions as competition
  join public.group_members as membership
    on membership.group_id = competition.group_id
  where competition.id = p_competition_id
    and membership.user_id = actor
    and membership.role = 'admin'
    and competition.status = 'review_pending'
  for update of competition;

  if not found then
    raise exception 'Competition administrator review access required'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.categories as category
    where category.competition_id = p_competition_id
  ) then
    raise exception 'At least one scoring category is required'
      using errcode = '55000';
  end if;

  with complete_ballots as (
    select vote.entry_id, vote.voter_id
    from public.votes as vote
    join public.entries as entry on entry.id = vote.entry_id
    join public.categories as category on category.id = vote.category_id
    where entry.competition_id = p_competition_id
      and not entry.is_disqualified
      and category.competition_id = p_competition_id
    group by vote.entry_id, vote.voter_id
    having count(distinct vote.category_id) = (
      select count(*) from public.categories as category
      where category.competition_id = p_competition_id
    )
  ),
  ballot_counts as (
    select ballot.entry_id, count(*)::integer as total
    from complete_ballots as ballot
    group by ballot.entry_id
  )
  select count(*)::integer,
         count(*) filter (where coalesce(ballot_counts.total, 0) < 1)::integer
    into eligible_count, missing_ballots
    from public.entries as entry
    left join ballot_counts on ballot_counts.entry_id = entry.id
    where entry.competition_id = p_competition_id
      and not entry.is_disqualified;

  if eligible_count = 0 then
    raise exception 'At least one eligible entry is required'
      using errcode = '55000';
  end if;
  if missing_ballots > 0 then
    raise exception 'Every published entry must have at least one complete ballot'
      using errcode = '55000';
  end if;

  with complete_ballots as (
    select vote.entry_id, vote.voter_id
    from public.votes as vote
    join public.entries as entry on entry.id = vote.entry_id
    join public.categories as category on category.id = vote.category_id
    where entry.competition_id = p_competition_id
      and not entry.is_disqualified
      and category.competition_id = p_competition_id
    group by vote.entry_id, vote.voter_id
    having count(distinct vote.category_id) = (
      select count(*) from public.categories as category
      where category.competition_id = p_competition_id
    )
  ),
  category_scores as (
    select vote.entry_id,
           vote.category_id,
           avg(vote.score::numeric / category.max_score * 100) as percentage
    from public.votes as vote
    join complete_ballots as ballot
      on ballot.entry_id = vote.entry_id and ballot.voter_id = vote.voter_id
    join public.categories as category
      on category.id = vote.category_id
     and category.competition_id = p_competition_id
    group by vote.entry_id, vote.category_id
  ),
  aggregates as (
    select category_score.entry_id,
           avg(category_score.percentage)::numeric(8, 4) as score,
           count(distinct ballot.voter_id)::integer as vote_count
    from category_scores as category_score
    join complete_ballots as ballot using (entry_id)
    group by category_score.entry_id
  ),
  ranked as (
    select aggregate.entry_id,
           rank() over (order by aggregate.score desc)::integer as entry_rank,
           aggregate.score,
           aggregate.vote_count
    from aggregates as aggregate
  )
  insert into public.published_competition_results (
    competition_id, entry_id, rank, score, vote_count
  )
  select p_competition_id,
         ranked.entry_id,
         ranked.entry_rank,
         ranked.score,
         ranked.vote_count
  from ranked;

  get diagnostics published_count = row_count;

  update public.competitions
    set status = 'completed'
    where id = p_competition_id;

  return published_count;
end;
$$;

create function public.get_published_competition_results(p_competition_id uuid)
returns table (
  rank integer,
  score numeric,
  vote_count integer,
  title text,
  creator_id uuid
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
    select result.rank, result.score, result.vote_count, entry.title, entry.creator_id
    from public.published_competition_results as result
    join public.entries as entry on entry.id = result.entry_id
    where result.competition_id = p_competition_id
    order by result.rank, entry.id;
end;
$$;

revoke all on function public.get_admin_review_results(uuid)
  from public, anon, authenticated;
grant execute on function public.get_admin_review_results(uuid) to authenticated;
revoke all on function public.disqualify_competition_entry(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.disqualify_competition_entry(uuid, uuid, text)
  to authenticated;
revoke all on function public.publish_competition_results(uuid)
  from public, anon, authenticated;
grant execute on function public.publish_competition_results(uuid)
  to authenticated;
revoke all on function public.get_published_competition_results(uuid)
  from public, anon, authenticated;
grant execute on function public.get_published_competition_results(uuid)
  to authenticated;

commit;
