begin;

alter table public.competitions
  add column submission_type text not null default 'photo'
    check (submission_type in ('photo', 'text'));

alter table public.entries
  add column submission_text text
    check (submission_text is null or char_length(submission_text) between 1 and 10000);

drop function public.save_draft_competition(
  uuid, uuid, text, text, timestamptz, timestamptz, jsonb, text, text, boolean, integer
);

create function public.save_draft_competition(
  p_competition_id uuid,
  p_group_id uuid,
  p_name text,
  p_event_type text,
  p_submission_deadline timestamptz,
  p_voting_deadline timestamptz,
  p_categories jsonb,
  p_description text default null,
  p_rules text default null,
  p_allow_participant_voting boolean default null,
  p_max_submission_images integer default null,
  p_submission_type text default 'photo'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_competition_id uuid;
  locked_competition_id uuid;
begin
  if p_submission_type is null or p_submission_type not in ('photo', 'text') then
    raise exception 'Submission type must be photo or text' using errcode = '22023';
  end if;
  if p_max_submission_images is not null
     and p_max_submission_images not between 1 and 20 then
    raise exception 'Photo limit must be from 1 to 20' using errcode = '22023';
  end if;

  saved_competition_id := public.save_draft_competition_base(
    p_competition_id,
    p_group_id,
    p_name,
    p_event_type,
    p_submission_deadline,
    p_voting_deadline,
    p_categories,
    p_description,
    p_rules,
    p_allow_participant_voting
  );

  select competition.id into locked_competition_id
    from public.competitions as competition
    where competition.id = saved_competition_id
    for update;

  if p_max_submission_images is not null and exists (
    select 1 from public.entries as entry
    where entry.competition_id = saved_competition_id
      and cardinality(entry.media_keys) > p_max_submission_images
  ) then
    raise exception 'Photo limit cannot be lower than photos already submitted'
      using errcode = '22023';
  end if;

  update public.competitions
    set max_submission_images = coalesce(p_max_submission_images, max_submission_images),
        submission_type = p_submission_type
    where id = saved_competition_id;

  return saved_competition_id;
end;
$$;

revoke all on function public.save_draft_competition(
  uuid, uuid, text, text, timestamptz, timestamptz, jsonb, text, text, boolean, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.save_draft_competition(
  uuid, uuid, text, text, timestamptz, timestamptz, jsonb, text, text, boolean, integer, text
) to authenticated;

alter function public.save_submission(uuid, uuid, text, text[])
  rename to save_photo_submission_base;
revoke all on function public.save_photo_submission_base(uuid, uuid, text, text[])
  from public, anon, authenticated, service_role;

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
  target_submission_type text;
begin
  select competition.submission_type
    into target_submission_type
    from public.competitions as competition
    where competition.id = p_competition_id;

  if target_submission_type = 'text' then
    raise exception 'Photo submissions are not enabled for this competition'
      using errcode = '22023';
  end if;

  return public.save_photo_submission_base(
    p_competition_id, p_entry_id, p_title, p_media_keys
  );
end;
$$;

revoke all on function public.save_submission(uuid, uuid, text, text[])
  from public, anon, authenticated, service_role;
grant execute on function public.save_submission(uuid, uuid, text, text[])
  to authenticated;

create function public.save_text_submission(
  p_competition_id uuid,
  p_entry_id uuid,
  p_title text,
  p_submission_text text
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
  target_submission_type text;
  saved_entry_id uuid;
  normalized_title text := btrim(p_title);
  normalized_text text := btrim(p_submission_text);
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select competition.group_id, competition.status, competition.submission_deadline,
      competition.submission_type
    into target_group_id, target_status, target_deadline, target_submission_type
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
  if target_submission_type <> 'text' then
    raise exception 'Text submissions are not enabled for this competition'
      using errcode = '22023';
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
  if normalized_title is null or char_length(normalized_title) not between 1 and 100 then
    raise exception 'Entry title must contain 1 to 100 characters' using errcode = '22023';
  end if;
  if normalized_text is null or char_length(normalized_text) not between 1 and 10000 then
    raise exception 'Submission text must contain 1 to 10000 characters'
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

  update public.entries
    set title = normalized_title,
        submission_text = normalized_text,
        media_keys = '{}'
    where id = saved_entry_id;

  return saved_entry_id;
end;
$$;

revoke all on function public.save_text_submission(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.save_text_submission(uuid, uuid, text, text)
  to authenticated;

drop function public.get_my_submission(uuid);
create function public.get_my_submission(p_competition_id uuid)
returns table (id uuid, title text, media_keys text[], submission_text text)
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
    select entry.id,
           case when entry.content_removed then 'Content removed' else entry.title end,
           entry.media_keys,
           case when entry.content_removed then null else entry.submission_text end
    from public.entries as entry
    where entry.competition_id = p_competition_id
      and entry.creator_id = actor;
end;
$$;
revoke all on function public.get_my_submission(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_my_submission(uuid) to authenticated;

drop function public.get_admin_submissions(uuid);
create function public.get_admin_submissions(p_competition_id uuid)
returns table (id uuid, creator_id uuid, title text, media_keys text[], submission_text text)
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
    raise exception 'Competition administrator access required' using errcode = '42501';
  end if;

  return query
    select entry.id,
           entry.creator_id,
           case when entry.content_removed then 'Content removed' else entry.title end,
           entry.media_keys,
           case when entry.content_removed then null else entry.submission_text end
    from public.entries as entry
    where entry.competition_id = p_competition_id
    order by entry.id;
end;
$$;
revoke all on function public.get_admin_submissions(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_admin_submissions(uuid) to authenticated;

drop function public.get_blind_voting_entries(uuid);
create function public.get_blind_voting_entries(p_competition_id uuid)
returns table (entry_number bigint, media_keys text[], submission_text text)
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
    join public.competition_participants as participant
      on participant.competition_id = competition.id
     and participant.user_id = actor
     and (participant.role = 'audience'
       or (participant.role = 'participant' and competition.allow_participant_voting))
    where competition.id = p_competition_id
      and membership.user_id = actor
      and competition.status = 'voting'
      and (competition.voting_deadline is null
        or clock_timestamp() < competition.voting_deadline)
  ) then
    raise exception 'Blind voting is not available' using errcode = '42501';
  end if;

  return query
    select entry.random_number::bigint,
           entry.media_keys,
           entry.submission_text
    from public.entries as entry
    where entry.competition_id = p_competition_id
      and entry.creator_id <> actor
      and not entry.is_disqualified
    order by entry.random_number, entry.id;
end;
$$;
revoke all on function public.get_blind_voting_entries(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_blind_voting_entries(uuid) to authenticated;

create or replace function public.can_upload_submission_media(p_name text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.competitions as competition
    where (storage.foldername(p_name))[1] = competition.id::text
      and competition.submission_type = 'text'
  ) then
    return false;
  end if;

  return public.can_upload_submission_media(
    p_name,
    case storage.extension(p_name)
      when 'jpg' then 'image/jpeg'
      when 'png' then 'image/png'
      when 'webp' then 'image/webp'
      when 'heic' then 'image/heic'
      when 'heif' then 'image/heif'
      else 'application/octet-stream'
    end,
    1::bigint
  );
end;
$$;
revoke all on function public.can_upload_submission_media(text) from public, anon, authenticated, service_role;
grant execute on function public.can_upload_submission_media(text) to authenticated;

drop function public.get_published_competition_results(uuid);
create function public.get_published_competition_results(p_competition_id uuid)
returns table (
  rank integer,
  score numeric,
  vote_count integer,
  title text,
  creator_id uuid,
  creator_name text,
  is_disqualified boolean,
  media_keys text[],
  submission_text text
)
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
      and competition.status = 'results_published'
  ) then
    raise exception 'Published results are not available' using errcode = '42501';
  end if;

  return query
    select result.rank,
           result.score,
           result.vote_count,
           coalesce(result.title, entry.title),
           coalesce(result.creator_id, entry.creator_id),
           coalesce(
             nullif(btrim(account.raw_user_meta_data ->> 'display_name'), ''),
             nullif(btrim(account.raw_user_meta_data ->> 'full_name'), ''),
             nullif(btrim(account.raw_user_meta_data ->> 'name'), ''),
             'Participant'
           ),
           result.is_disqualified,
           case
             when result.is_disqualified or entry.content_removed then '{}'::text[]
             else entry.media_keys
           end,
           case
             when result.is_disqualified or entry.content_removed then null
             else entry.submission_text
           end
    from public.published_competition_results as result
    join public.entries as entry on entry.id = result.entry_id
    left join auth.users as account
      on account.id = coalesce(result.creator_id, entry.creator_id)
    where result.competition_id = p_competition_id
    order by result.rank, result.entry_id;
end;
$$;
revoke all on function public.get_published_competition_results(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_published_competition_results(uuid) to authenticated;

create function public.clear_removed_submission_text()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.content_removed then
    new.submission_text := null;
  end if;
  return new;
end;
$$;

create trigger entries_clear_removed_submission_text
before update of content_removed on public.entries
for each row
execute function public.clear_removed_submission_text();

commit;
