begin;

create function public.delete_competition(p_competition_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_group_id uuid;
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select competition.group_id
    into target_group_id
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

  if exists (
    select 1
    from public.entries as entry
    join public.entry_disqualification_events as event
      on event.entry_id = entry.id
    where entry.competition_id = p_competition_id
  ) then
    raise exception 'Competitions with disqualification audit records cannot be removed'
      using errcode = '23503';
  end if;

  delete from public.competitions as competition
    where competition.id = p_competition_id;
end;
$$;

revoke all on function public.delete_competition(uuid)
  from public, anon, authenticated;
grant execute on function public.delete_competition(uuid) to authenticated;

commit;
