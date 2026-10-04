begin;

alter table public.entries rename column media_urls to media_keys;

alter table public.entries
  add constraint entries_title_length_check
    check (char_length(btrim(title)) between 1 and 100);

create unique index entries_competition_creator_unique_idx
  on public.entries (competition_id, creator_id);

revoke all on public.entries, public.votes from public, anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'competition-submissions',
  'competition-submissions',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']
);

create function public.save_submission(
  p_competition_id uuid,
  p_entry_id uuid,
  p_title text,
  p_media_keys text[]
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_group_id uuid;
  target_status text;
  target_deadline timestamptz;
  saved_entry_id uuid;
  normalized_title text := btrim(p_title);
  media_count integer;
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select competition.group_id, competition.status, competition.submission_deadline
    into target_group_id, target_status, target_deadline
    from public.competitions as competition
    where competition.id = p_competition_id
    for update;

  if not found or not exists (
    select 1 from public.group_members as membership
    where membership.group_id = target_group_id
      and membership.user_id = actor
  ) then
    raise exception 'Competition not found or access denied' using errcode = '42501';
  end if;

  if target_status <> 'submission'
     or (target_deadline is not null and clock_timestamp() >= target_deadline) then
    raise exception 'Submissions are not open' using errcode = '55000';
  end if;

  if normalized_title is null
     or char_length(normalized_title) not between 1 and 100 then
    raise exception 'Entry title must contain 1 to 100 characters'
      using errcode = '22023';
  end if;
  if p_media_keys is null or cardinality(p_media_keys) > 5
     or array_position(p_media_keys, null) is not null then
    raise exception 'An entry may contain up to five valid media files'
      using errcode = '22023';
  end if;

  if p_entry_id is null then
    select entry.id into saved_entry_id
      from public.entries as entry
      where entry.competition_id = p_competition_id
        and entry.creator_id = actor
      for update;

    if not found then
      insert into public.entries (competition_id, creator_id, title)
      values (p_competition_id, actor, normalized_title)
      returning id into saved_entry_id;
    end if;
  else
    select entry.id into saved_entry_id
      from public.entries as entry
      where entry.id = p_entry_id
        and entry.competition_id = p_competition_id
        and entry.creator_id = actor
      for update;

    if not found then
      raise exception 'Entry not found or access denied' using errcode = '42501';
    end if;
  end if;

  media_count := cardinality(p_media_keys);
  if exists (
    select 1
    from unnest(p_media_keys) as item(media_key)
    where item.media_key !~ (
      '^' || p_competition_id::text || '/' || saved_entry_id::text
      || '/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$'
    )
  ) or (
    select count(distinct item.media_key)
    from unnest(p_media_keys) as item(media_key)
  ) <> media_count then
    raise exception 'Media keys are invalid' using errcode = '22023';
  end if;

  if media_count > 0 and (
    select count(*)
    from storage.objects as object
    where object.bucket_id = 'competition-submissions'
      and object.name = any(p_media_keys)
      and object.owner_id = actor::text
      and object.metadata ->> 'mimetype' in ('image/jpeg', 'image/png', 'image/webp')
      and case when (object.metadata ->> 'size') ~ '^[0-9]{1,8}$'
        then (object.metadata ->> 'size')::bigint between 1 and 10485760
        else false end
      and case object.metadata ->> 'mimetype'
        when 'image/jpeg' then storage.filename(object.name) ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$'
        when 'image/png' then storage.filename(object.name) ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$'
        when 'image/webp' then storage.filename(object.name) ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$'
        else false end
  ) <> media_count then
    raise exception 'Media files are missing or invalid' using errcode = '22023';
  end if;

  update public.entries
    set title = normalized_title,
        media_keys = p_media_keys
    where id = saved_entry_id;

  return saved_entry_id;
end;
$$;

create function public.get_my_submission(p_competition_id uuid)
returns table (id uuid, title text, media_keys text[])
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null or not exists (
    select 1
    from public.competitions as competition
    join public.group_members as membership
      on membership.group_id = competition.group_id
    where competition.id = p_competition_id
      and membership.user_id = actor
  ) then
    raise exception 'Competition not found or access denied' using errcode = '42501';
  end if;

  return query
    select entry.id, entry.title, entry.media_keys
    from public.entries as entry
    where entry.competition_id = p_competition_id
      and entry.creator_id = actor;
end;
$$;

create function public.get_admin_submissions(p_competition_id uuid)
returns table (id uuid, creator_id uuid, title text, media_keys text[])
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null or not exists (
    select 1
    from public.competitions as competition
    join public.group_members as membership
      on membership.group_id = competition.group_id
    where competition.id = p_competition_id
      and membership.user_id = actor
      and membership.role = 'admin'
  ) then
    raise exception 'Competition administrator access required'
      using errcode = '42501';
  end if;

  return query
    select entry.id, entry.creator_id, entry.title, entry.media_keys
    from public.entries as entry
    where entry.competition_id = p_competition_id
    order by entry.id;
end;
$$;

create function public.get_blind_voting_entries(p_competition_id uuid)
returns table (entry_number bigint, media_keys text[])
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null or not exists (
    select 1
    from public.competitions as competition
    join public.group_members as membership
      on membership.group_id = competition.group_id
    where competition.id = p_competition_id
      and membership.user_id = actor
      and competition.status = 'voting'
      and (competition.voting_deadline is null
        or clock_timestamp() < competition.voting_deadline)
  ) then
    raise exception 'Blind voting is not available' using errcode = '42501';
  end if;

  return query
    select row_number() over (order by entry.random_number nulls last, entry.id),
           entry.media_keys
    from public.entries as entry
    where entry.competition_id = p_competition_id
      and not entry.is_disqualified
    order by entry.random_number nulls last, entry.id;
end;
$$;

create function public.can_upload_submission_media(p_name text, p_mimetype text, p_size bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_status text;
  target_deadline timestamptz;
  unreferenced_count integer;
begin
  if actor is null
     or p_mimetype not in ('image/jpeg', 'image/png', 'image/webp')
      or p_size is null
      or p_size not between 1 and 10485760
      or (case p_mimetype
       when 'image/jpeg' then storage.filename(p_name) !~
         '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$'
       when 'image/png' then storage.filename(p_name) !~
         '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$'
       when 'image/webp' then storage.filename(p_name) !~
         '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$'
       else true end) then
    return false;
  end if;

  select competition.status, competition.submission_deadline
    into target_status, target_deadline
    from public.entries as entry
    join public.competitions as competition
      on competition.id = entry.competition_id
    join public.group_members as membership
      on membership.group_id = competition.group_id
    where (storage.foldername(p_name))[1] = competition.id::text
      and (storage.foldername(p_name))[2] = entry.id::text
      and entry.creator_id = actor
      and membership.user_id = actor
    for update of competition;

  if not found or target_status <> 'submission'
     or (target_deadline is not null and clock_timestamp() >= target_deadline) then
    return false;
  end if;

  select count(*) into unreferenced_count
    from storage.objects as object
    join public.entries as entry
      on (storage.foldername(object.name))[1] = entry.competition_id::text
     and (storage.foldername(object.name))[2] = entry.id::text
    where object.bucket_id = 'competition-submissions'
      and entry.id::text = (storage.foldername(p_name))[2]
      and not (object.name = any(entry.media_keys));

  return unreferenced_count < 5;
end;
$$;

create function public.can_read_submission_media(p_name text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.entries as entry
      join public.competitions as competition
        on competition.id = entry.competition_id
      join public.group_members as membership
        on membership.group_id = competition.group_id
      where (storage.foldername(p_name))[1] = competition.id::text
        and (storage.foldername(p_name))[2] = entry.id::text
        and membership.user_id = auth.uid()
        and (
          membership.role = 'admin'
          or (
            competition.status = 'submission'
            and entry.creator_id = auth.uid()
          )
          or (
            competition.status = 'voting'
            and p_name = any(entry.media_keys)
            and (competition.voting_deadline is null
              or clock_timestamp() < competition.voting_deadline)
          )
        )
    );
$$;

create function public.can_delete_submission_media(p_name text)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.entries as entry
      join public.competitions as competition
        on competition.id = entry.competition_id
      join public.group_members as membership
        on membership.group_id = competition.group_id
      where (storage.foldername(p_name))[1] = competition.id::text
        and (storage.foldername(p_name))[2] = entry.id::text
        and membership.user_id = auth.uid()
        and entry.creator_id = auth.uid()
        and not (p_name = any(entry.media_keys))
    );
$$;

revoke all on function public.save_submission(uuid, uuid, text, text[]) from public, anon, authenticated;
grant execute on function public.save_submission(uuid, uuid, text, text[]) to authenticated;
revoke all on function public.get_my_submission(uuid) from public, anon, authenticated;
grant execute on function public.get_my_submission(uuid) to authenticated;
revoke all on function public.get_admin_submissions(uuid) from public, anon, authenticated;
grant execute on function public.get_admin_submissions(uuid) to authenticated;
revoke all on function public.get_blind_voting_entries(uuid) from public, anon, authenticated;
grant execute on function public.get_blind_voting_entries(uuid) to authenticated;
revoke all on function public.can_upload_submission_media(text, text, bigint) from public, anon, authenticated;
grant execute on function public.can_upload_submission_media(text, text, bigint) to authenticated;
revoke all on function public.can_read_submission_media(text) from public, anon, authenticated;
grant execute on function public.can_read_submission_media(text) to authenticated;
revoke all on function public.can_delete_submission_media(text) from public, anon, authenticated;
grant execute on function public.can_delete_submission_media(text) to authenticated;

create policy "Submission media upload"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'competition-submissions'
  and public.can_upload_submission_media(
    name,
    metadata ->> 'mimetype',
    case when (metadata ->> 'size') ~ '^[0-9]{1,8}$'
      then (metadata ->> 'size')::bigint else null end
  )
);

create policy "Authorized submission media read"
on storage.objects for select to authenticated
using (
  bucket_id = 'competition-submissions'
  and public.can_read_submission_media(name)
);

create policy "Authorized submission media cleanup"
on storage.objects for delete to authenticated
using (
  bucket_id = 'competition-submissions'
  and public.can_delete_submission_media(name)
);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'entries'
    ) then
      alter publication supabase_realtime drop table public.entries;
    end if;
    if exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'votes'
    ) then
      alter publication supabase_realtime drop table public.votes;
    end if;
  end if;
end;
$$;

commit;
