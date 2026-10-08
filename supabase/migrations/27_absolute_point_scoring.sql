begin;

update public.published_competition_category_results as result
set score = (result.score * category.max_score / 100)::numeric(8, 4)
from public.categories as category
where category.id = result.category_id;

with overall_scores as (
  select result.competition_id, result.entry_id,
         avg(category_result.score)::numeric(8, 4) as score
  from public.published_competition_results as result
  join public.published_competition_category_results as category_result
    on category_result.competition_id = result.competition_id
   and category_result.entry_id = result.entry_id
  where not result.is_disqualified
  group by result.competition_id, result.entry_id
),
ranked as (
  select score.*,
         rank() over (
           partition by score.competition_id
           order by score.score desc
         )::integer as entry_rank
  from overall_scores as score
)
update public.published_competition_results as result
set score = ranked.score, rank = ranked.entry_rank
from ranked
where result.competition_id = ranked.competition_id
  and result.entry_id = ranked.entry_id;

update public.published_competition_results as result
set rank = null, score = null
where result.is_disqualified
  and result.entry_id in (
    select entry.id
    from public.entries as entry
    where entry.disqualification_display <> 'bottom'
  );

with eligible_ranks as (
  select result.competition_id, coalesce(max(result.rank), 0) as max_rank
  from public.published_competition_results as result
  where not result.is_disqualified
  group by result.competition_id
),
bottom_entries as (
  select result.competition_id, result.entry_id, eligible.max_rank
         + row_number() over (
           partition by result.competition_id
           order by result.entry_id
         )::integer as entry_rank
  from public.published_competition_results as result
  join public.entries as entry on entry.id = result.entry_id
  join eligible_ranks as eligible using (competition_id)
  where result.is_disqualified
    and entry.disqualification_display = 'bottom'
)
update public.published_competition_results as result
set rank = bottom.entry_rank, score = null
from bottom_entries as bottom
where result.competition_id = bottom.competition_id
  and result.entry_id = bottom.entry_id;

create or replace function public.get_admin_review_results(p_competition_id uuid)
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
  disqualified_at timestamptz,
  disqualification_display text,
  content_removed boolean
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
      select vote.entry_id, vote.category_id,
             avg(vote.score::numeric) as score
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
             avg(category_score.score)::numeric(8, 4) as score,
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
           case when entry.content_removed then 'Content removed' else entry.title end,
           entry.is_disqualified,
           case
             when not entry.is_disqualified then ranked.entry_rank
             when entry.disqualification_display = 'bottom' then
               (select coalesce(max(eligible.entry_rank), 0) from ranked as eligible)
               + (
                 select count(*)::integer
                 from public.entries as earlier
                 where earlier.competition_id = entry.competition_id
                   and earlier.is_disqualified
                   and earlier.disqualification_display = 'bottom'
                   and earlier.id <= entry.id
               )
             else null
           end,
           case when entry.is_disqualified then null else ranked.score end,
           case when entry.is_disqualified then 0 else coalesce(ranked.vote_count, 0) end,
           latest_event.reason,
           latest_event.actor_id,
           latest_event.created_at,
           entry.disqualification_display,
           entry.content_removed
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
    order by
      case
        when not entry.is_disqualified then 0
        when entry.disqualification_display = 'bottom' then 1
        else 2
      end,
      ranked.entry_rank nulls last,
      entry.id;
end;
$$;

create or replace function public.get_admin_review_category_results(p_competition_id uuid)
returns table (
  category_id uuid,
  category_name text,
  entry_id uuid,
  title text,
  creator_id uuid,
  rank integer,
  score numeric
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
      select vote.entry_id, vote.category_id,
             avg(vote.score::numeric)::numeric(8, 4) as score
      from public.votes as vote
      join complete_ballots as ballot
        on ballot.entry_id = vote.entry_id and ballot.voter_id = vote.voter_id
      join public.categories as category
        on category.id = vote.category_id
       and category.competition_id = p_competition_id
      group by vote.entry_id, vote.category_id
    )
    select category.id, category.name, entry.id,
           case when entry.content_removed then 'Content removed' else entry.title end,
           entry.creator_id,
           rank() over (partition by category.id order by scores.score desc)::integer,
           scores.score
    from category_scores as scores
    join public.entries as entry on entry.id = scores.entry_id
    join public.categories as category on category.id = scores.category_id
    where not entry.is_disqualified
    order by category.name, rank() over (partition by category.id order by scores.score desc),
             entry.id;
end;
$$;

create or replace function public.publish_competition_results(p_competition_id uuid)
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
  if actor is null and auth.role() is distinct from 'service_role' then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  perform 1
  from public.competitions as competition
  where competition.id = p_competition_id
    and competition.status = 'review_pending'
    and (
      auth.role() = 'service_role'
      or exists (
        select 1 from public.group_members as membership
        where membership.group_id = competition.group_id
          and membership.user_id = actor
          and membership.role = 'admin'
      )
    )
  for update;
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

  delete from public.published_competition_results
  where competition_id = p_competition_id;
  delete from public.published_competition_category_results
  where competition_id = p_competition_id;

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
    select vote.entry_id, vote.category_id,
           avg(vote.score::numeric) as score
    from public.votes as vote
    join complete_ballots as ballot
      on ballot.entry_id = vote.entry_id and ballot.voter_id = vote.voter_id
    join public.categories as category
      on category.id = vote.category_id
     and category.competition_id = p_competition_id
    group by vote.entry_id, vote.category_id
  ),
  category_ranked as (
    select category_score.category_id,
           category_score.entry_id,
           rank() over (
             partition by category_score.category_id
             order by category_score.score::numeric(8, 4) desc
           )::integer as entry_rank,
           category_score.score::numeric(8, 4) as score
    from category_scores as category_score
  )
  insert into public.published_competition_category_results (
    competition_id, category_id, entry_id, rank, score
  )
  select p_competition_id, category_ranked.category_id,
         category_ranked.entry_id, category_ranked.entry_rank, category_ranked.score
  from category_ranked;

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
    select vote.entry_id, vote.category_id,
           avg(vote.score::numeric) as score
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
           avg(category_score.score)::numeric(8, 4) as score,
           count(distinct ballot.voter_id)::integer as vote_count
    from category_scores as category_score
    join complete_ballots as ballot using (entry_id)
    group by category_score.entry_id
  ),
  eligible_ranked as (
    select aggregate.entry_id,
           rank() over (order by aggregate.score desc)::integer as entry_rank,
           aggregate.score,
           aggregate.vote_count
    from aggregates as aggregate
  ),
  ranked_entries as (
    select entry.id as entry_id,
           eligible_ranked.entry_rank as entry_rank,
           eligible_ranked.score,
           eligible_ranked.vote_count,
           false as is_disqualified,
           entry.title,
           entry.creator_id
    from eligible_ranked
    join public.entries as entry on entry.id = eligible_ranked.entry_id
    union all
    select entry.id,
           (select coalesce(max(entry_rank), 0) from eligible_ranked)
             + row_number() over (order by entry.id)::integer,
           null::numeric,
           0,
           true,
           case when entry.content_removed then 'Content removed' else entry.title end,
           entry.creator_id
    from public.entries as entry
    where entry.competition_id = p_competition_id
      and entry.is_disqualified
      and entry.disqualification_display = 'bottom'
  )
  insert into public.published_competition_results (
    competition_id, entry_id, rank, score, vote_count, title, creator_id, is_disqualified
  )
  select p_competition_id, ranked_entries.entry_id, ranked_entries.entry_rank,
         ranked_entries.score, ranked_entries.vote_count, ranked_entries.title,
         ranked_entries.creator_id, ranked_entries.is_disqualified
  from ranked_entries;

  get diagnostics published_count = row_count;
  update public.competitions
    set status = 'results_published', results_publish_at = null
    where id = p_competition_id;
  return published_count;
end;
$$;

commit;
