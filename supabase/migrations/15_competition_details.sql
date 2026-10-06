begin;

alter table public.competitions
  add column description text,
  add column rules text,
  add constraint competitions_description_length_check
    check (char_length(description) <= 10000),
  add constraint competitions_rules_length_check
    check (char_length(rules) <= 10000);

create function public.save_competition_details(
  p_competition_id uuid,
  p_name text,
  p_description text,
  p_rules text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_group_id uuid;
  normalized_name text := btrim(p_name);
  normalized_description text := nullif(btrim(p_description), '');
  normalized_rules text := nullif(btrim(p_rules), '');
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select competition.group_id into target_group_id
    from public.competitions as competition
    where competition.id = p_competition_id
    for update;

  if not found then
    raise exception 'Competition not found or access denied' using errcode = '42501';
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

  update public.competitions
    set name = normalized_name,
        description = normalized_description,
        rules = normalized_rules
    where id = p_competition_id;

  return p_competition_id;
end;
$$;

revoke all on function public.save_competition_details(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.save_competition_details(uuid, text, text, text)
  to authenticated;

-- Replace rather than overload: existing seven-argument calls use the defaults.
drop function public.save_draft_competition(
  uuid, uuid, text, text, timestamptz, timestamptz, jsonb
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
  p_rules text default null
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
      description, rules
    )
    values (
      target_group_id, normalized_name, p_event_type,
      p_submission_deadline, p_voting_deadline,
      normalized_description, normalized_rules
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
          rules = normalized_rules
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

revoke all on function public.save_draft_competition(
  uuid, uuid, text, text, timestamptz, timestamptz, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.save_draft_competition(
  uuid, uuid, text, text, timestamptz, timestamptz, jsonb, text, text
) to authenticated;

commit;
