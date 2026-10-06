begin;

alter table public.competitions
  add column allow_participant_voting boolean not null default false;

-- Replace the signature so legacy seven- and nine-argument calls remain unambiguous.
drop function public.save_draft_competition(
  uuid, uuid, text, text, timestamptz, timestamptz, jsonb, text, text
);

create function public.save_draft_competition(
  p_competition_id uuid,
  p_group_id uuid,
  p_name text,
  p_event_type text,
  p_submission_deadline timestamptz,
  p_voting_deadline timestamptz,
  p_categories jsonb,
  p_description text default null,
  p_rules text default null,
  p_allow_participant_voting boolean default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  normalized_name text := btrim(p_name);
  normalized_description text := nullif(btrim(p_description), '');
  normalized_rules text := nullif(btrim(p_rules), '');
  target_group_id uuid := p_group_id;
  target_status text;
  saved_competition_id uuid;
  category_item jsonb;
  category_name text;
  category_max_score integer;
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if p_competition_id is not null then
    select competition.group_id, competition.status
      into target_group_id, target_status
      from public.competitions as competition
      where competition.id = p_competition_id
      for update;

    if not found or target_group_id is distinct from p_group_id then
      raise exception 'Competition not found or access denied' using errcode = '42501';
    end if;
    if target_status <> 'draft' then
      raise exception 'Only draft competitions can be edited' using errcode = '55000';
    end if;
  end if;

  if not exists (
    select 1 from public.group_members as membership
    where membership.group_id = target_group_id
      and membership.user_id = actor
      and membership.role = 'admin'
  ) then
    raise exception 'Group administrator access required' using errcode = '42501';
  end if;

  if normalized_name is null
     or char_length(normalized_name) not between 1 and 100 then
    raise exception 'Competition name must contain 1 to 100 characters'
      using errcode = '22023';
  end if;
  if char_length(normalized_description) > 10000
     or char_length(normalized_rules) > 10000 then
    raise exception 'Competition description and rules must contain at most 10000 characters'
      using errcode = '22023';
  end if;
  if p_event_type is null or p_event_type not in ('live', 'remote') then
    raise exception 'Event type must be live or remote' using errcode = '22023';
  end if;
  if p_submission_deadline is not null
     and p_voting_deadline is not null
     and p_voting_deadline <= p_submission_deadline then
    raise exception 'Voting deadline must be after the submission deadline'
      using errcode = '22023';
  end if;
  if p_categories is null or jsonb_typeof(p_categories) <> 'array'
     or jsonb_array_length(p_categories) = 0 then
    raise exception 'At least one scoring category is required'
      using errcode = '22023';
  end if;

  for category_item in
    select value from jsonb_array_elements(p_categories)
  loop
    category_name := btrim(category_item ->> 'name');
    if jsonb_typeof(category_item) is distinct from 'object'
       or category_name is null
       or char_length(category_name) not between 1 and 100 then
      raise exception 'Category names must contain 1 to 100 characters'
        using errcode = '22023';
    end if;
    if jsonb_typeof(category_item -> 'max_score') is distinct from 'number'
       or (category_item ->> 'max_score') !~ '^[1-5]$' then
      raise exception 'Category maximum scores must be from 1 to 5'
        using errcode = '22023';
    end if;
  end loop;

  if (
    select count(*) <> count(distinct lower(btrim(value ->> 'name')))
    from jsonb_array_elements(p_categories)
  ) then
    raise exception 'Category names must be unique' using errcode = '22023';
  end if;

  if p_competition_id is null then
    insert into public.competitions (
      group_id, name, event_type, submission_deadline, voting_deadline,
      description, rules, allow_participant_voting
    )
    values (
      target_group_id, normalized_name, p_event_type,
      p_submission_deadline, p_voting_deadline,
      normalized_description, normalized_rules, coalesce(p_allow_participant_voting, false)
    )
    returning id into saved_competition_id;
  else
    if exists (
      select 1
      from public.categories as category
      join public.votes as vote on vote.category_id = category.id
      where category.competition_id = p_competition_id
    ) then
      raise exception 'Scoring criteria with votes cannot be replaced'
        using errcode = '55000';
    end if;

    update public.competitions
      set name = normalized_name,
          event_type = p_event_type,
          submission_deadline = p_submission_deadline,
          voting_deadline = p_voting_deadline,
          description = normalized_description,
          rules = normalized_rules,
          allow_participant_voting = coalesce(p_allow_participant_voting, allow_participant_voting)
      where id = p_competition_id
    returning id into saved_competition_id;

    delete from public.categories
      where competition_id = saved_competition_id;
  end if;

  for category_item in
    select value from jsonb_array_elements(p_categories)
  loop
    category_name := btrim(category_item ->> 'name');
    category_max_score := (category_item ->> 'max_score')::integer;
    insert into public.categories (competition_id, name, max_score)
    values (saved_competition_id, category_name, category_max_score);
  end loop;

  return saved_competition_id;
end;
$$;

create or replace function public.save_ballot(
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
  target_allow_participant_voting boolean;
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

  select competition.status, competition.voting_deadline, competition.allow_participant_voting
    into target_status, target_deadline, target_allow_participant_voting
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

  if not exists (
    select 1 from public.competition_participants as participant
    where participant.competition_id = p_competition_id
      and participant.user_id = actor
      and (participant.role = 'audience'
        or (participant.role = 'participant' and target_allow_participant_voting))
  ) then
    raise exception 'Join the competition in an eligible voting role' using errcode = '42501';
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
    join public.competition_participants as participant
      on participant.competition_id = competition.id
     and participant.user_id = actor
     and (participant.role = 'audience'
       or (participant.role = 'participant' and competition.allow_participant_voting))
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

-- The Storage read policy already delegates here. Match blind-voting eligibility
-- without changing administrators' review or published-results access.
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

-- Supabase default privileges can include service_role; voting RPCs are for
-- authenticated callers only, and the obsolete single-score API stays closed.
revoke all on function public.save_draft_competition(
  uuid, uuid, text, text, timestamptz, timestamptz, jsonb, text, text, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.save_draft_competition(
  uuid, uuid, text, text, timestamptz, timestamptz, jsonb, text, text, boolean
) to authenticated;
revoke all on function public.save_ballot(uuid, bigint, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.save_ballot(uuid, bigint, jsonb) to authenticated;
revoke all on function public.get_blind_voting_entries(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_blind_voting_entries(uuid) to authenticated;
revoke all on function public.can_read_submission_media(text)
  from public, anon, authenticated, service_role;
grant execute on function public.can_read_submission_media(text) to authenticated;
revoke all on function public.cast_vote(uuid, bigint, uuid, integer)
  from public, anon, authenticated, service_role;

commit;
