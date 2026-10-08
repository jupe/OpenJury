begin;

alter function public.save_draft_competition(
  uuid, uuid, text, text, timestamptz, timestamptz, jsonb, text, text,
  boolean, integer, text
) rename to save_draft_competition_base;
revoke all on function public.save_draft_competition_base(
  uuid, uuid, text, text, timestamptz, timestamptz, jsonb, text, text,
  boolean, integer, text
) from public, anon, authenticated, service_role;

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
