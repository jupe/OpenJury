begin;

alter table public.competitions
  add constraint competitions_name_length_check
    check (char_length(btrim(name)) between 1 and 100),
  add constraint competitions_deadline_order_check
    check (
      submission_deadline is null
      or voting_deadline is null
      or voting_deadline > submission_deadline
    );

alter table public.categories
  add constraint categories_name_length_check
    check (char_length(btrim(name)) between 1 and 100),
  add constraint categories_max_score_range_check
    check (max_score between 1 and 5);

create unique index categories_competition_name_unique_idx
  on public.categories (competition_id, lower(btrim(name)));

revoke all on public.competitions, public.categories from public, anon, authenticated;
grant select on public.competitions, public.categories to authenticated;

create policy "Group members read competitions"
on public.competitions for select to authenticated
using (
  exists (
    select 1 from public.group_members
    where group_members.group_id = competitions.group_id
      and group_members.user_id = (select auth.uid())
  )
);

create policy "Group members read categories"
on public.categories for select to authenticated
using (
  exists (
    select 1
    from public.competitions
    join public.group_members
      on group_members.group_id = competitions.group_id
    where competitions.id = categories.competition_id
      and group_members.user_id = (select auth.uid())
  )
);

create function public.save_draft_competition(
  p_competition_id uuid,
  p_group_id uuid,
  p_name text,
  p_event_type text,
  p_submission_deadline timestamptz,
  p_voting_deadline timestamptz,
  p_categories jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  normalized_name text := btrim(p_name);
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

    if not found or target_group_id <> p_group_id then
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
  if p_event_type not in ('live', 'remote') then
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
    if jsonb_typeof(category_item) <> 'object'
       or category_name is null
       or char_length(category_name) not between 1 and 100 then
      raise exception 'Category names must contain 1 to 100 characters'
        using errcode = '22023';
    end if;
    if jsonb_typeof(category_item -> 'max_score') <> 'number'
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
      group_id, name, event_type, submission_deadline, voting_deadline
    )
    values (
      target_group_id, normalized_name, p_event_type,
      p_submission_deadline, p_voting_deadline
    )
    returning id into saved_competition_id;
  else
    update public.competitions
      set name = normalized_name,
          event_type = p_event_type,
          submission_deadline = p_submission_deadline,
          voting_deadline = p_voting_deadline
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
  uuid, uuid, text, text, timestamptz, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.save_draft_competition(
  uuid, uuid, text, text, timestamptz, timestamptz, jsonb
) to authenticated;

commit;
