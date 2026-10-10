begin;

drop function public.get_platform_groups();

create function public.get_platform_groups()
returns table (
  id uuid, name text, member_count integer, admin_count integer, my_role text,
  created_at timestamptz, creator_name text, creator_email text,
  competition_count integer, competition_status_counts jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Platform administrator access required' using errcode = '42501';
  end if;
  return query
    select target_group.id, target_group.name,
      (select count(*)::integer from public.group_members as membership
        where membership.group_id = target_group.id),
      (select count(*)::integer from public.group_members as membership
        where membership.group_id = target_group.id and membership.role = 'admin'),
      (select membership.role from public.group_members as membership
        where membership.group_id = target_group.id and membership.user_id = auth.uid()),
      target_group.created_at,
      coalesce(
        nullif(btrim(creator.raw_user_meta_data ->> 'display_name'), ''),
        nullif(btrim(creator.raw_user_meta_data ->> 'full_name'), ''),
        nullif(btrim(creator.raw_user_meta_data ->> 'name'), '')
      ),
      creator.email::text,
      coalesce(summary.total, 0)::integer,
      coalesce(summary.states, '{}'::jsonb)
    from public.groups as target_group
    left join auth.users as creator on creator.id = target_group.created_by
    left join lateral (
      select sum(state_counts.amount) as total,
        jsonb_object_agg(state_counts.status, state_counts.amount) as states
      from (
        select competition.status, count(*)::integer as amount
        from public.competitions as competition
        where competition.group_id = target_group.id
        group by competition.status
      ) as state_counts
    ) as summary on true
    order by lower(target_group.name), target_group.id;
end;
$$;

revoke all on function public.get_platform_groups()
  from public, anon, authenticated, service_role;
grant execute on function public.get_platform_groups() to authenticated;

commit;
