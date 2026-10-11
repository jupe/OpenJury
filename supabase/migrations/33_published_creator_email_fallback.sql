begin;

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
  media_keys text[],
  submission_text text
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
    select result.rank,
           result.score,
           result.vote_count,
           coalesce(result.title, entry.title),
           coalesce(result.creator_id, entry.creator_id),
           coalesce(
             nullif(btrim(account.raw_user_meta_data ->> 'display_name'), ''),
             nullif(btrim(account.raw_user_meta_data ->> 'full_name'), ''),
             nullif(btrim(account.raw_user_meta_data ->> 'name'), ''),
             nullif(btrim(account.email), ''),
             'Participant'
           ),
           result.is_disqualified,
           case
             when result.is_disqualified or entry.content_removed then '{}'::text[]
             else entry.media_keys
           end,
           case
             when result.is_disqualified or entry.content_removed then null
             else entry.submission_text
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
  from public, anon, authenticated, service_role;
grant execute on function public.get_published_competition_results(uuid)
  to authenticated;

drop function public.get_published_competition_category_results(uuid);
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
      and competition.status = 'results_published'
  ) then
    raise exception 'Published results are not available'
      using errcode = '42501';
  end if;

  return query
    select result.category_id,
           category.name,
           result.rank,
           result.score,
           entry.title,
           coalesce(
             nullif(btrim(account.raw_user_meta_data ->> 'display_name'), ''),
             nullif(btrim(account.raw_user_meta_data ->> 'full_name'), ''),
             nullif(btrim(account.raw_user_meta_data ->> 'name'), ''),
             nullif(btrim(account.email), ''),
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

revoke all on function public.get_published_competition_category_results(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_published_competition_category_results(uuid)
  to authenticated;

commit;
