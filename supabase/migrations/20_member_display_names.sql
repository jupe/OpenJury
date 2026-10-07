begin;

drop function public.get_group_members(uuid);

create function public.get_group_members(p_group_id uuid)
returns table (user_id uuid, email text, role text, display_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_group_admin(p_group_id);
  return query
    select membership.user_id, account.email::text, membership.role,
           coalesce(
             nullif(btrim(account.raw_user_meta_data ->> 'display_name'), ''),
             nullif(btrim(account.raw_user_meta_data ->> 'full_name'), ''),
             nullif(btrim(account.raw_user_meta_data ->> 'name'), '')
           )
    from public.group_members as membership
    join auth.users as account on account.id = membership.user_id
    where membership.group_id = p_group_id
    order by membership.role, lower(account.email);
end;
$$;

revoke all on function public.get_group_members(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_group_members(uuid) to authenticated;

commit;
