begin;

alter table public.competitions
  add column results_publish_at timestamptz;

alter table public.entries
  add column disqualification_display text not null default 'exclude'
    check (disqualification_display in ('exclude', 'bottom', 'remove_content')),
  add column content_removed boolean not null default false;

alter table public.entry_disqualification_events
  add column disposition text not null default 'exclude'
    check (disposition in ('exclude', 'bottom', 'remove_content'));

alter table public.published_competition_results
  alter column score drop not null,
  alter column vote_count set default 0,
  add column title text,
  add column creator_id uuid references auth.users(id),
  add column is_disqualified boolean not null default false;

update public.published_competition_results as result
set title = entry.title,
    creator_id = entry.creator_id
from public.entries as entry
where entry.id = result.entry_id;

create table public.published_competition_category_results (
  competition_id uuid not null references public.competitions(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  entry_id uuid not null references public.entries(id) on delete cascade,
  rank integer not null check (rank > 0),
  score numeric(8, 4) not null,
  primary key (competition_id, category_id, entry_id)
);

alter table public.published_competition_category_results enable row level security;
revoke all on public.published_competition_category_results from public, anon, authenticated;

with complete_ballots as (
  select result.competition_id, vote.entry_id, vote.voter_id
  from public.published_competition_results as result
  join public.votes as vote on vote.entry_id = result.entry_id
  join public.entries as entry on entry.id = vote.entry_id
  join public.categories as category on category.id = vote.category_id
  where not result.is_disqualified
    and category.competition_id = result.competition_id
  group by result.competition_id, vote.entry_id, vote.voter_id
  having count(distinct vote.category_id) = (
    select count(*) from public.categories as category
    where category.competition_id = result.competition_id
  )
),
category_scores as (
  select ballot.competition_id, vote.category_id, vote.entry_id,
         avg(vote.score::numeric / category.max_score * 100)::numeric(8, 4) as score
  from complete_ballots as ballot
  join public.votes as vote
    on vote.entry_id = ballot.entry_id and vote.voter_id = ballot.voter_id
  join public.categories as category
    on category.id = vote.category_id
   and category.competition_id = ballot.competition_id
  group by ballot.competition_id, vote.category_id, vote.entry_id
),
category_ranked as (
  select score.*,
         rank() over (
           partition by score.competition_id, score.category_id
           order by score.score desc
         )::integer as category_rank
  from category_scores as score
)
insert into public.published_competition_category_results (
  competition_id, category_id, entry_id, rank, score
)
select competition_id, category_id, entry_id, category_rank, score
from category_ranked;

create function public.set_competition_results_schedule(
  p_competition_id uuid,
  p_publish_at timestamptz
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
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

  if p_publish_at is not null and p_publish_at <= clock_timestamp() then
    raise exception 'Scheduled publication time must be in the future'
      using errcode = '22023';
  end if;

  update public.competitions
    set results_publish_at = p_publish_at
    where id = p_competition_id;

  return p_publish_at;
end;
$$;

drop function public.get_admin_review_results(uuid);

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

create function public.get_admin_review_category_results(p_competition_id uuid)
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
             avg(vote.score::numeric / category.max_score * 100)::numeric(8, 4) as score
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

drop function public.disqualify_competition_entry(uuid, uuid, text);

create function public.disqualify_competition_entry(
  p_competition_id uuid,
  p_entry_id uuid,
  p_reason text,
  p_disposition text default 'exclude'
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
  if p_disposition is null or p_disposition not in ('exclude', 'bottom', 'remove_content') then
    raise exception 'Invalid disqualification disposition' using errcode = '22023';
  end if;

  update public.entries
    set is_disqualified = true,
        disqualification_display = p_disposition,
        content_removed = content_removed or p_disposition = 'remove_content',
        title = case when p_disposition = 'remove_content' then 'Content removed' else title end,
        media_keys = case when p_disposition = 'remove_content' then '{}' else media_keys end
    where id = p_entry_id
      and competition_id = p_competition_id
      and not is_disqualified;

  if not found then
    raise exception 'Entry not found or already disqualified'
      using errcode = '22023';
  end if;

  insert into public.entry_disqualification_events (entry_id, actor_id, reason, disposition)
  values (p_entry_id, actor, normalized_reason, p_disposition);
end;
$$;

create function public.reinstate_competition_entry(
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
     or char_length(normalized_reason) not between 1 and 488 then
    raise exception 'Reinstatement reason must contain 1 to 488 characters'
      using errcode = '22023';
  end if;
  update public.entries
    set is_disqualified = false,
        disqualification_display = 'exclude'
    where id = p_entry_id
      and competition_id = p_competition_id
      and is_disqualified
      and not content_removed;
  if not found then
    raise exception 'Entry not found or its content has been removed'
      using errcode = '22023';
  end if;
  insert into public.entry_disqualification_events (entry_id, actor_id, reason, disposition)
  values (p_entry_id, actor, 'Reinstated: ' || normalized_reason, 'exclude');
end;
$$;

create or replace function public.can_delete_submission_media(p_name text)
returns boolean
language sql
security definer
stable
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
        and (
          (
            entry.creator_id = auth.uid()
            and not (p_name = any(entry.media_keys))
          )
          or (
            membership.role = 'admin'
            and competition.status = 'review_pending'
            and entry.is_disqualified
            and entry.content_removed
          )
        )
    );
$$;

revoke all on function public.can_delete_submission_media(text)
  from public, anon, authenticated;
grant execute on function public.can_delete_submission_media(text) to authenticated;

create trigger published_competition_category_results_broadcast_change
after insert or update or delete on public.published_competition_category_results
for each row execute function public.broadcast_group_change();

revoke all on function public.get_admin_review_results(uuid)
  from public, anon, authenticated;
grant execute on function public.get_admin_review_results(uuid) to authenticated;

-- The existing storage policy delegates each deletion to the function above.

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
           avg(vote.score::numeric / category.max_score * 100) as percentage
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
             order by category_score.percentage::numeric(8, 4) desc
           )::integer as entry_rank,
           category_score.percentage::numeric(8, 4) as score
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
    set status = 'completed', results_publish_at = null
    where id = p_competition_id;
  return published_count;
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
  creator_name text,
  is_disqualified boolean
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
    select result.rank, result.score, result.vote_count, result.title, result.creator_id,
           coalesce(
             nullif(btrim(account.raw_user_meta_data ->> 'display_name'), ''),
             nullif(btrim(account.raw_user_meta_data ->> 'full_name'), ''),
             nullif(btrim(account.raw_user_meta_data ->> 'name'), ''),
             'Participant'
           ),
           result.is_disqualified
    from public.published_competition_results as result
    left join auth.users as account on account.id = result.creator_id
    where result.competition_id = p_competition_id
    order by result.rank, result.entry_id;
end;
$$;

create function public.get_published_competition_category_results(p_competition_id uuid)
returns table (
  category_id uuid,
  category_name text,
  rank integer,
  score numeric,
  title text,
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
    select result.category_id, category.name, result.rank, result.score,
           entry.title,
           coalesce(
             nullif(btrim(account.raw_user_meta_data ->> 'display_name'), ''),
             nullif(btrim(account.raw_user_meta_data ->> 'full_name'), ''),
             nullif(btrim(account.raw_user_meta_data ->> 'name'), ''),
             'Participant'
           )
    from public.published_competition_category_results as result
    join public.categories as category on category.id = result.category_id
    join public.entries as entry on entry.id = result.entry_id
    left join auth.users as account on account.id = entry.creator_id
    where result.competition_id = p_competition_id
    order by category.name, result.rank, entry.id;
end;
$$;

create or replace function public.process_scheduled_competition_publications()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  target record;
  published_count integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;

  for target in
    select competition.id
    from public.competitions as competition
    where competition.status = 'review_pending'
      and competition.results_publish_at <= clock_timestamp()
    order by competition.results_publish_at, competition.id
    for update of competition skip locked
  loop
    begin
      perform public.publish_competition_results(target.id);
      published_count := published_count + 1;
    exception when others then
      raise warning 'Scheduled publication failed for competition %: %', target.id, sqlerrm;
    end;
  end loop;
  return published_count;
end;
$$;

revoke all on function public.process_scheduled_competition_publications()
  from public, anon, authenticated;
grant execute on function public.process_scheduled_competition_publications()
  to service_role;
revoke all on function public.set_competition_results_schedule(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.set_competition_results_schedule(uuid, timestamptz)
  to authenticated;
revoke all on function public.get_admin_review_category_results(uuid)
  from public, anon, authenticated;
grant execute on function public.get_admin_review_category_results(uuid)
  to authenticated;
revoke all on function public.disqualify_competition_entry(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.disqualify_competition_entry(uuid, uuid, text, text)
  to authenticated;
revoke all on function public.reinstate_competition_entry(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.reinstate_competition_entry(uuid, uuid, text)
  to authenticated;
revoke all on function public.get_published_competition_results(uuid)
  from public, anon, authenticated;
grant execute on function public.get_published_competition_results(uuid)
  to authenticated;
revoke all on function public.get_published_competition_category_results(uuid)
  from public, anon, authenticated;
grant execute on function public.get_published_competition_category_results(uuid)
  to authenticated;
revoke all on function public.publish_competition_results(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.publish_competition_results(uuid)
  to authenticated, service_role;

commit;
