begin;

create function public.rename_group(p_group_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  normalized_name text := btrim(p_name);
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  perform 1
    from public.groups as target_group
    where target_group.id = p_group_id
    for update;

  if not found or not exists (
    select 1 from public.group_members as membership
    where membership.group_id = p_group_id
      and membership.user_id = actor
      and membership.role = 'admin'
  ) then
    raise exception 'Group administrator access required'
      using errcode = '42501';
  end if;

  if normalized_name is null
     or char_length(normalized_name) not between 1 and 100 then
    raise exception 'Group name must contain 1 to 100 characters'
      using errcode = '22023';
  end if;

  update public.groups as target_group
    set name = normalized_name
    where target_group.id = p_group_id;
end;
$$;

revoke all on function public.rename_group(uuid, text)
  from public, anon, authenticated;
grant execute on function public.rename_group(uuid, text) to authenticated;

create function public.delete_group(p_group_id uuid)
returns void
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
    from public.groups as target_group
    where target_group.id = p_group_id
    for update;

  if not found or not exists (
    select 1 from public.group_members as membership
    where membership.group_id = p_group_id
      and membership.user_id = actor
      and membership.role = 'admin'
  ) then
    raise exception 'Group administrator access required'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from public.competitions as competition
    join public.entries as entry
      on entry.competition_id = competition.id
    join public.entry_disqualification_events as event
      on event.entry_id = entry.id
    where competition.group_id = p_group_id
  ) then
    raise exception 'Groups with disqualification audit records cannot be removed'
      using errcode = '23503';
  end if;

  delete from public.groups as target_group
    where target_group.id = p_group_id;
end;
$$;

revoke all on function public.delete_group(uuid)
  from public, anon, authenticated;
grant execute on function public.delete_group(uuid) to authenticated;

commit;
