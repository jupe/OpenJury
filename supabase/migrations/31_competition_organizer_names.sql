begin;

create function public.get_competition_organizer_first_names(p_competition_id uuid)
returns table (first_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_group_id uuid;
begin
  select competition.group_id into target_group_id
  from public.competitions as competition
  join public.group_members as membership
    on membership.group_id = competition.group_id
  where competition.id = p_competition_id
    and membership.user_id = actor;

  if actor is null or target_group_id is null then
    raise exception 'Competition membership required'
      using errcode = '42501';
  end if;

  return query
    select organizer.first_name
    from (
      select split_part(
        regexp_replace(
          btrim(coalesce(
            nullif(btrim(account.raw_user_meta_data ->> 'display_name'), ''),
            nullif(btrim(account.raw_user_meta_data ->> 'full_name'), ''),
            nullif(btrim(account.raw_user_meta_data ->> 'name'), ''),
            'Organizer'
          )),
          '\s+',
          ' '
        ),
        ' ',
        1
      ) as first_name,
      membership.user_id
      from public.group_members as membership
      join auth.users as account on account.id = membership.user_id
      where membership.group_id = target_group_id
        and membership.role = 'admin'
    ) as organizer
    order by lower(organizer.first_name), organizer.user_id;
end;
$$;

revoke all on function public.get_competition_organizer_first_names(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_competition_organizer_first_names(uuid)
  to authenticated;

commit;
