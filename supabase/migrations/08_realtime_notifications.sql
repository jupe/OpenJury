begin;

create function public.can_receive_realtime_topic(target_topic text)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_group_id uuid;
begin
  if actor is null or target_topic is null then
    return false;
  end if;

  if target_topic = 'user:' || actor::text then
    return true;
  end if;

  if target_topic !~ '^group:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;

  target_group_id := substring(target_topic from '^group:(.*)$')::uuid;
  return exists (
    select 1
    from public.group_members as membership
    where membership.group_id = target_group_id
      and membership.user_id = actor
  );
end;
$$;

revoke all on function public.can_receive_realtime_topic(text)
  from public, anon, authenticated;
grant execute on function public.can_receive_realtime_topic(text)
  to authenticated;

alter table realtime.messages enable row level security;
revoke insert, update, delete on realtime.messages from public, anon, authenticated;
grant select on realtime.messages to authenticated;

create policy "OpenJury members receive private notifications"
on realtime.messages for select to authenticated
using (public.can_receive_realtime_topic(realtime.topic()));

create function public.broadcast_group_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_group_id uuid;
  affected_competition_id uuid;
  affected_entry_id uuid;
  affected_user_id uuid;
begin
  if tg_table_name = 'groups' then
    affected_group_id := coalesce(new.id, old.id);
  elsif tg_table_name = 'group_members' then
    if tg_op = 'DELETE' then
      affected_group_id := old.group_id;
      affected_user_id := old.user_id;
    else
      affected_group_id := new.group_id;
      affected_user_id := new.user_id;
    end if;
  elsif tg_table_name = 'competitions' then
    affected_group_id := coalesce(new.group_id, old.group_id);
  elsif tg_table_name = 'published_competition_results' then
    affected_competition_id := coalesce(new.competition_id, old.competition_id);
  elsif tg_table_name = 'categories' then
    affected_competition_id := coalesce(new.competition_id, old.competition_id);
  elsif tg_table_name = 'entries' then
    affected_competition_id := coalesce(new.competition_id, old.competition_id);
  elsif tg_table_name = 'votes' then
    affected_entry_id := coalesce(new.entry_id, old.entry_id);
    select entry.competition_id into affected_competition_id
    from public.entries as entry
    where entry.id = affected_entry_id;
  elsif tg_table_name = 'entry_disqualification_events' then
    affected_entry_id := coalesce(new.entry_id, old.entry_id);
    select entry.competition_id into affected_competition_id
    from public.entries as entry
    where entry.id = affected_entry_id;
  end if;

  if affected_competition_id is not null then
    select competition.group_id into affected_group_id
    from public.competitions as competition
    where competition.id = affected_competition_id;
  end if;

  if affected_group_id is not null then
    perform realtime.send(
      jsonb_build_object('version', 1),
      'data_changed',
      'group:' || affected_group_id::text,
      true
    );
  end if;

  if affected_user_id is not null then
    perform realtime.send(
      jsonb_build_object('version', 1),
      'membership_changed',
      'user:' || affected_user_id::text,
      true
    );
  end if;

  return null;
end;
$$;

revoke all on function public.broadcast_group_change()
  from public, anon, authenticated;

create trigger groups_broadcast_change
after insert or update or delete on public.groups
for each row execute function public.broadcast_group_change();

create trigger group_members_broadcast_change
after insert or update or delete on public.group_members
for each row execute function public.broadcast_group_change();

create trigger competitions_broadcast_change
after insert or update or delete on public.competitions
for each row execute function public.broadcast_group_change();

create trigger categories_broadcast_change
after insert or update or delete on public.categories
for each row execute function public.broadcast_group_change();

create trigger entries_broadcast_change
after insert or update or delete on public.entries
for each row execute function public.broadcast_group_change();

create trigger votes_broadcast_change
after insert or update or delete on public.votes
for each row execute function public.broadcast_group_change();

create trigger entry_disqualification_events_broadcast_change
after insert or update or delete on public.entry_disqualification_events
for each row execute function public.broadcast_group_change();

create trigger published_competition_results_broadcast_change
after insert or update or delete on public.published_competition_results
for each row execute function public.broadcast_group_change();

commit;
