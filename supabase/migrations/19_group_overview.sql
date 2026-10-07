begin;

-- High-level details for the caller's own groups. Members may read only their
-- own membership row, so roster size comes from this aggregate projection; it
-- exposes counts and the caller's role, never other members' identities.
create function public.get_my_groups()
returns table (
  id uuid,
  name text,
  my_role text,
  member_count integer,
  admin_count integer,
  competition_count integer,
  active_competition_count integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select target_group.id, target_group.name, mine.role,
    (select count(*)::integer from public.group_members as membership
      where membership.group_id = target_group.id),
    (select count(*)::integer from public.group_members as membership
      where membership.group_id = target_group.id and membership.role = 'admin'),
    (select count(*)::integer from public.competitions as competition
      where competition.group_id = target_group.id),
    (select count(*)::integer from public.competitions as competition
      where competition.group_id = target_group.id
        and competition.status in ('submission', 'voting'))
  from public.group_members as mine
  join public.groups as target_group on target_group.id = mine.group_id
  where mine.user_id = (select auth.uid())
  order by lower(target_group.name), target_group.id;
$$;

revoke all on function public.get_my_groups() from public, anon, authenticated, service_role;
grant execute on function public.get_my_groups() to authenticated;

commit;
