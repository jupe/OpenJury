begin;

create or replace function public.transition_competition(
  p_competition_id uuid,
  p_target_status text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_group_id uuid;
  current_status text;
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select competition.group_id, competition.status
    into target_group_id, current_status
    from public.competitions as competition
    where competition.id = p_competition_id
    for update;

  if not found or not exists (
    select 1 from public.group_members as membership
    where membership.group_id = target_group_id
      and membership.user_id = actor
      and membership.role = 'admin'
  ) then
    raise exception 'Competition administrator access required'
      using errcode = '42501';
  end if;

  if p_target_status is null or not (
    (current_status = 'draft' and p_target_status = 'submission')
    or (current_status = 'submission' and p_target_status = 'voting')
    or (current_status = 'voting' and p_target_status = 'review_pending')
    or (current_status = 'submission' and p_target_status = 'draft')
    or (current_status = 'voting' and p_target_status = 'submission')
    or (current_status = 'review_pending' and p_target_status = 'voting')
    or (current_status = 'results_published' and p_target_status = 'review_pending')
  ) then
    raise exception 'Invalid competition status transition'
      using errcode = '55000';
  end if;

  if current_status = 'submission' and p_target_status = 'draft'
     and exists (
       select 1 from public.competition_start_email_outbox as email
       where email.competition_id = p_competition_id
     ) then
    raise exception 'Competition cannot return to draft after start notifications were queued'
      using errcode = '55000';
  end if;

  if current_status = 'voting' and p_target_status = 'submission' then
    if exists (
      select 1
      from public.votes as vote
      join public.entries as entry on entry.id = vote.entry_id
      where entry.competition_id = p_competition_id
    ) then
      raise exception 'Competition cannot reopen submissions after voting has started'
        using errcode = '55000';
    end if;
    update public.entries
      set random_number = null
      where competition_id = p_competition_id;
  end if;

  if current_status = 'review_pending' and p_target_status = 'voting' then
    if exists (
      select 1 from public.competitions as competition
      where competition.id = p_competition_id
        and competition.voting_deadline is not null
        and competition.voting_deadline <= clock_timestamp()
    ) then
      raise exception 'Competition cannot reopen voting after the voting deadline'
        using errcode = '55000';
    end if;
    update public.competitions
      set results_publish_at = null
      where id = p_competition_id;
  end if;

  if current_status = 'results_published' and p_target_status = 'review_pending' then
    delete from public.published_competition_results
      where competition_id = p_competition_id;
    delete from public.published_competition_category_results
      where competition_id = p_competition_id;
    update public.competitions
      set results_publish_at = null
      where id = p_competition_id;
  end if;

  if p_target_status = 'voting' then
    perform public.assign_competition_entry_numbers(p_competition_id);
  end if;

  update public.competitions
    set status = p_target_status
    where id = p_competition_id;

  return p_target_status;
end;
$$;

commit;
