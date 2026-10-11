begin;

alter table public.groups alter column created_by drop not null;
alter table public.groups drop constraint groups_created_by_fkey;
alter table public.groups add constraint groups_created_by_fkey
  foreign key (created_by) references auth.users(id) on delete set null;

create table public.user_activity (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_active_at timestamptz not null default clock_timestamp()
);
alter table public.user_activity enable row level security;
revoke all on public.user_activity from public, anon, authenticated, service_role;

create table public.account_deletion_requests (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.account_deletion_requests enable row level security;
revoke all on public.account_deletion_requests from public, anon, authenticated, service_role;

create function public.account_allows_upload()
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 35));
  return exists (select 1 from auth.users where id = auth.uid())
    and not exists (select 1 from public.account_deletion_requests where user_id = auth.uid());
end;
$$;

create policy "Deleting accounts cannot upload submissions"
on storage.objects as restrictive for insert to authenticated
with check (bucket_id <> 'competition-submissions' or public.account_allows_upload());

create function public.record_my_activity()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from auth.users where id = auth.uid()) then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  insert into public.user_activity(user_id) values (auth.uid())
  on conflict (user_id) do update set last_active_at = clock_timestamp();
end;
$$;

create function public.get_platform_users(p_offset integer default 0)
returns table (
  id uuid, email text, display_name text, created_at timestamptz,
  last_active_at timestamptz, groups jsonb
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Platform administrator access required' using errcode = '42501';
  end if;
  if p_offset is null or p_offset < 0 then
    raise exception 'Invalid offset' using errcode = '22023';
  end if;
  return query select account.id, account.email::text,
    coalesce(nullif(btrim(account.raw_user_meta_data ->> 'display_name'), ''),
      nullif(btrim(account.raw_user_meta_data ->> 'full_name'), ''),
      nullif(btrim(account.raw_user_meta_data ->> 'name'), '')),
    account.created_at,
    greatest(activity.last_active_at, account.last_sign_in_at),
    coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'role', m.role)
      order by lower(g.name), g.id)
      from public.group_members m join public.groups g on g.id = m.group_id
      where m.user_id = account.id), '[]'::jsonb)
  from auth.users account left join public.user_activity activity on activity.user_id = account.id
  order by account.created_at, account.id limit 100 offset p_offset;
end;
$$;

create function public.get_account_deletion_media(p_user_id uuid)
returns table (name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (select 1 from auth.users where id = auth.uid())
    or (p_user_id is distinct from auth.uid() and not public.is_platform_admin()) then
    raise exception 'Account deletion access required' using errcode = '42501';
  end if;
  return query select object.name from storage.objects object
    where object.bucket_id = 'competition-submissions' and (
      object.owner_id = p_user_id::text or object.owner = p_user_id
      or exists (select 1 from public.entries entry where entry.creator_id = p_user_id
        and (storage.foldername(object.name))[1] = entry.competition_id::text
        and (storage.foldername(object.name))[2] = entry.id::text))
    order by object.name limit 1000;
end;
$$;

create function public.delete_account(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  target_email text;
begin
  if auth.uid() is null or not exists (select 1 from auth.users where id = auth.uid())
    or (p_user_id is distinct from auth.uid() and not public.is_platform_admin()) then
    raise exception 'Account deletion access required' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 35));
  select email into target_email from auth.users where id = p_user_id for update;
  if not found then
    raise exception 'Account not found' using errcode = '22023';
  end if;
  -- A concurrent upload or failed Storage request must not leave private files behind.
  if exists (select 1 from public.get_account_deletion_media(p_user_id)) then
    raise exception 'Account media cleanup required; please retry' using errcode = '55000';
  end if;
  delete from public.entry_disqualification_events event
    where event.actor_id = p_user_id or exists (
      select 1 from public.entries entry where entry.id = event.entry_id and entry.creator_id = p_user_id);
  delete from public.published_competition_results where creator_id = p_user_id;
  delete from public.entries where creator_id = p_user_id;
  delete from public.votes where voter_id = p_user_id;
  delete from public.group_email_invites
    where email = lower(target_email) or invited_by = p_user_id;
  delete from public.group_invites where created_by = p_user_id;
  delete from public.platform_admins where email = lower(target_email);
  delete from auth.users where id = p_user_id;
end;
$$;

create function public.prepare_account_deletion(p_user_id uuid)
returns table (name text)
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (select 1 from auth.users where id = auth.uid())
    or (p_user_id is distinct from auth.uid() and not public.is_platform_admin()) then
    raise exception 'Account deletion access required' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 35));
  perform 1 from auth.users where id = p_user_id for update;
  if not found then
    raise exception 'Account not found' using errcode = '22023';
  end if;
  insert into public.account_deletion_requests values (p_user_id) on conflict do nothing;
  return query select media.name from public.get_account_deletion_media(p_user_id) media;
end;
$$;

revoke all on function public.record_my_activity(), public.get_platform_users(integer),
  public.get_account_deletion_media(uuid), public.delete_account(uuid),
  public.prepare_account_deletion(uuid), public.account_allows_upload()
  from public, anon, authenticated, service_role;
grant execute on function public.record_my_activity(), public.get_platform_users(integer),
  public.get_account_deletion_media(uuid), public.delete_account(uuid),
  public.prepare_account_deletion(uuid), public.account_allows_upload() to authenticated;

commit;
