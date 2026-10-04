begin;

revoke all on public.groups, public.group_members from public, anon, authenticated;
grant select on public.groups, public.group_members to authenticated;

-- Reading only one's own membership avoids recursive membership policies.
create policy "Members read their own memberships"
on public.group_members for select to authenticated
using (user_id = (select auth.uid()));

create policy "Members read their groups"
on public.groups for select to authenticated
using (
  exists (
    select 1 from public.group_members
    where group_members.group_id = groups.id
      and group_members.user_id = (select auth.uid())
  )
);

-- No direct writes: group creation and its first admin membership are atomic.
create function public.create_group(group_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  creator uuid := auth.uid();
  normalized_name text := btrim(group_name);
  new_group_id uuid;
begin
  if creator is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if normalized_name is null
     or char_length(normalized_name) not between 1 and 100 then
    raise exception 'Group name must contain 1 to 100 characters'
      using errcode = '22023';
  end if;

  insert into public.groups (name, created_by)
  values (normalized_name, creator)
  returning id into new_group_id;

  insert into public.group_members (group_id, user_id, role)
  values (new_group_id, creator, 'admin');

  return new_group_id;
end;
$$;

revoke all on function public.create_group(text) from public, anon, authenticated;
grant execute on function public.create_group(text) to authenticated;

-- Competition, category, entry, and vote access remains deny-by-default.
commit;
