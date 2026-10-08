begin;

create function public.reject_self_vote()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.entries as entry
    where entry.id = new.entry_id
      and entry.creator_id = new.voter_id
  ) then
    raise exception 'Self-voting is not permitted' using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger votes_reject_self_vote
before insert or update of entry_id, voter_id on public.votes
for each row execute function public.reject_self_vote();

revoke all on function public.reject_self_vote() from public, anon, authenticated, service_role;

commit;
