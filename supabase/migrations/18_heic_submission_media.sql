begin;

update storage.buckets
  set allowed_mime_types = array[
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'
  ]
  where id = 'competition-submissions';

create or replace function public.can_upload_submission_media(
  p_name text,
  p_mimetype text,
  p_size bigint
)
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
     or p_mimetype not in (
       'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'
     )
     or p_size is null
     or p_size not between 1 and 10485760
     or (case p_mimetype
       when 'image/jpeg' then storage.filename(p_name) !~
         '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$'
       when 'image/png' then storage.filename(p_name) !~
         '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$'
       when 'image/webp' then storage.filename(p_name) !~
         '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$'
       when 'image/heic' then storage.filename(p_name) !~
         '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.heic$'
       when 'image/heif' then storage.filename(p_name) !~
         '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.heif$'
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

create or replace function public.save_submission(
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

  if not exists (
    select 1 from public.competition_participants as participant
    where participant.competition_id = p_competition_id
      and participant.user_id = actor
      and participant.role = 'participant'
  ) then
    raise exception 'Join the competition as a participant to submit an entry'
      using errcode = '42501';
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
      || '/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp|heic|heif)$'
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
      and object.metadata ->> 'mimetype' in (
        'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'
      )
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
        when 'image/heic' then storage.filename(object.name) ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.heic$'
        when 'image/heif' then storage.filename(object.name) ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.heif$'
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

commit;
