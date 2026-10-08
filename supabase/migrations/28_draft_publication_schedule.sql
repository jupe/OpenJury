begin;

alter function public.save_draft_competition_base(
  uuid, uuid, text, text, timestamptz, timestamptz, jsonb, text, text, boolean
) rename to save_draft_competition_legacy;
revoke all on function public.save_draft_competition_legacy(
  uuid, uuid, text, text, timestamptz, timestamptz, jsonb, text, text, boolean
) from public, anon, authenticated, service_role;

alter function public.save_draft_competition(
  uuid, uuid, text, text, timestamptz, timestamptz, jsonb, text, text,
  boolean, integer, text
) rename to save_draft_competition_base;
revoke all on function public.save_draft_competition_base(
  uuid, uuid, text, text, timestamptz, timestamptz, jsonb, text, text,
  boolean, integer, text
) from public, anon, authenticated, service_role;

create or replace function public.save_draft_competition_base(
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

  saved_competition_id := public.save_draft_competition_legacy(
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
  p_submission_type text default 'photo',
  p_results_publish_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_competition_id uuid;
begin
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
    p_allow_participant_voting,
    p_max_submission_images,
    p_submission_type
  );

  if p_results_publish_at is not null
     and p_results_publish_at <= clock_timestamp() then
    raise exception 'Scheduled publication time must be in the future'
      using errcode = '22023';
  end if;

  update public.competitions
    set results_publish_at = p_results_publish_at
    where id = saved_competition_id;

  return saved_competition_id;
end;
$$;

revoke all on function public.save_draft_competition(
  uuid, uuid, text, text, timestamptz, timestamptz, jsonb, text, text,
  boolean, integer, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.save_draft_competition(
  uuid, uuid, text, text, timestamptz, timestamptz, jsonb, text, text,
  boolean, integer, text, timestamptz
) to authenticated;

commit;
