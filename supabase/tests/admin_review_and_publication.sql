-- Run with psql as the database owner after applying all migrations.
-- Fixtures and RPC-created data are rolled back.
begin;

insert into auth.users (id) values
  ('00000000-0000-0000-0000-000000000061'),
  ('00000000-0000-0000-0000-000000000062'),
  ('00000000-0000-0000-0000-000000000063'),
  ('00000000-0000-0000-0000-000000000064'),
  ('00000000-0000-0000-0000-000000000065'),
  ('00000000-0000-0000-0000-000000000066'),
  ('00000000-0000-0000-0000-000000000067'),
  ('00000000-0000-0000-0000-000000000068');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000061', true);
select public.create_group('Admin review tenant');

reset role;
insert into public.group_members (group_id, user_id, role)
select id, user_id, 'member'
from public.groups
cross join (values
  ('00000000-0000-0000-0000-000000000062'::uuid),
  ('00000000-0000-0000-0000-000000000063'::uuid),
  ('00000000-0000-0000-0000-000000000064'::uuid),
  ('00000000-0000-0000-0000-000000000065'::uuid),
  ('00000000-0000-0000-0000-000000000066'::uuid),
  ('00000000-0000-0000-0000-000000000067'::uuid)
) as members(user_id)
where groups.name = 'Admin review tenant';

insert into public.competitions (
  id, group_id, name, event_type, status
)
select
  '00000000-0000-0000-0000-000000000071',
  id,
  'Review and publication',
  'remote',
  'voting'
from public.groups where name = 'Admin review tenant';
insert into public.categories (id, competition_id, name, max_score) values
  ('00000000-0000-0000-0000-000000000072', '00000000-0000-0000-0000-000000000071', 'Quality', 5),
  ('00000000-0000-0000-0000-000000000073', '00000000-0000-0000-0000-000000000071', 'Style', 2);
insert into public.entries (
  id, competition_id, creator_id, title, random_number
) values
  ('00000000-0000-0000-0000-000000000074', '00000000-0000-0000-0000-000000000071', '00000000-0000-0000-0000-000000000062', 'Entry Alpha', 1),
  ('00000000-0000-0000-0000-000000000075', '00000000-0000-0000-0000-000000000071', '00000000-0000-0000-0000-000000000063', 'Entry Beta', 2),
  ('00000000-0000-0000-0000-000000000076', '00000000-0000-0000-0000-000000000071', '00000000-0000-0000-0000-000000000064', 'Entry Gamma', 3),
  ('00000000-0000-0000-0000-000000000078', '00000000-0000-0000-0000-000000000071', '00000000-0000-0000-0000-000000000067', 'Entry Delta', 4);
-- Media for the published-results gallery checks.
update public.entries
set media_keys = array['00000000-0000-0000-0000-000000000071/00000000-0000-0000-0000-000000000074/00000000-0000-0000-0000-000000000081.jpg']
where id = '00000000-0000-0000-0000-000000000074';
update public.entries
set media_keys = array['00000000-0000-0000-0000-000000000071/00000000-0000-0000-0000-000000000076/00000000-0000-0000-0000-000000000082.jpg']
where id = '00000000-0000-0000-0000-000000000076';

-- Since competition roles, only the audience may vote.
insert into public.competition_participants (competition_id, user_id, role) values
  ('00000000-0000-0000-0000-000000000071', '00000000-0000-0000-0000-000000000062', 'participant'),
  ('00000000-0000-0000-0000-000000000071', '00000000-0000-0000-0000-000000000063', 'participant'),
  ('00000000-0000-0000-0000-000000000071', '00000000-0000-0000-0000-000000000064', 'participant'),
  ('00000000-0000-0000-0000-000000000071', '00000000-0000-0000-0000-000000000067', 'participant'),
  ('00000000-0000-0000-0000-000000000071', '00000000-0000-0000-0000-000000000065', 'audience'),
  ('00000000-0000-0000-0000-000000000071', '00000000-0000-0000-0000-000000000066', 'audience');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000065', true);
select public.save_ballot(
  '00000000-0000-0000-0000-000000000071', 1,
  '[{"category_id":"00000000-0000-0000-0000-000000000072","score":5},{"category_id":"00000000-0000-0000-0000-000000000073","score":2}]'
);
select public.save_ballot(
  '00000000-0000-0000-0000-000000000071', 2,
  '[{"category_id":"00000000-0000-0000-0000-000000000072","score":4},{"category_id":"00000000-0000-0000-0000-000000000073","score":2}]'
);
-- An incomplete ballot (one of two categories). cast_vote is no longer
-- callable by members, so the partial vote is written directly.
reset role;
insert into public.votes (entry_id, voter_id, category_id, score) values (
  '00000000-0000-0000-0000-000000000076',
  '00000000-0000-0000-0000-000000000065',
  '00000000-0000-0000-0000-000000000072',
  5
);
set local role authenticated;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000066', true);
select public.save_ballot(
  '00000000-0000-0000-0000-000000000071', 1,
  '[{"category_id":"00000000-0000-0000-0000-000000000072","score":3},{"category_id":"00000000-0000-0000-0000-000000000073","score":1}]'
);
select public.save_ballot(
  '00000000-0000-0000-0000-000000000071', 2,
  '[{"category_id":"00000000-0000-0000-0000-000000000072","score":4},{"category_id":"00000000-0000-0000-0000-000000000073","score":1}]'
);
select public.save_ballot(
  '00000000-0000-0000-0000-000000000071', 4,
  '[{"category_id":"00000000-0000-0000-0000-000000000072","score":1},{"category_id":"00000000-0000-0000-0000-000000000073","score":1}]'
);
reset role;
update public.competitions
set status = 'review_pending'
where id = '00000000-0000-0000-0000-000000000071';

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000065', true);
do $$
begin
  begin
    perform public.get_admin_review_results('00000000-0000-0000-0000-000000000071');
    raise exception 'A member read preliminary results';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_admin_review_category_results('00000000-0000-0000-0000-000000000071');
    raise exception 'A member read preliminary category results';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.disqualify_competition_entry(
      '00000000-0000-0000-0000-000000000071',
      '00000000-0000-0000-0000-000000000076',
      'Not eligible'
    );
    raise exception 'A member disqualified an entry';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.publish_competition_results('00000000-0000-0000-0000-000000000071');
    raise exception 'A member published results';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.set_competition_results_schedule(
      '00000000-0000-0000-0000-000000000071', now() + interval '1 hour'
    );
    raise exception 'A member changed the publication schedule';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_published_competition_results('00000000-0000-0000-0000-000000000071');
    raise exception 'Results were visible before publication';
  exception when insufficient_privilege then null;
  end;
  begin
    select count(*) from public.published_competition_results;
    raise exception 'Authenticated users read the publication table directly';
  exception when insufficient_privilege then null;
  end;
  begin
    select count(*) from public.published_competition_category_results;
    raise exception 'Authenticated users read category snapshots directly';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000061', true);
set local role authenticated;
do $$
declare
  result_record record;
  first_schedule timestamptz := now() + interval '1 hour';
  replacement_schedule timestamptz := now() + interval '2 hours';
begin
  if (select count(*) from public.get_admin_review_results(
    '00000000-0000-0000-0000-000000000071'
  )) <> 4 then
    raise exception 'Admin could not review every entry';
  end if;

  select * into result_record
  from public.get_admin_review_results('00000000-0000-0000-0000-000000000071')
  where entry_id = '00000000-0000-0000-0000-000000000074';
  if result_record.rank <> 1 or result_record.score <> 77.5
     or result_record.vote_count <> 2 or result_record.is_disqualified then
    raise exception 'Category-normalized aggregation or complete-ballot count failed';
  end if;

  select * into result_record
  from public.get_admin_review_results('00000000-0000-0000-0000-000000000071')
  where entry_id = '00000000-0000-0000-0000-000000000075';
  if result_record.rank <> 1 or result_record.score <> 77.5
     or result_record.vote_count <> 2 then
    raise exception 'Equal scores did not receive the same rank';
  end if;

  select * into result_record
  from public.get_admin_review_results('00000000-0000-0000-0000-000000000071')
  where entry_id = '00000000-0000-0000-0000-000000000078';
  if result_record.rank <> 3 or result_record.score <> 35
     or result_record.vote_count <> 1 then
    raise exception 'Ties or the one-complete-ballot minimum were not applied';
  end if;

  select * into result_record
  from public.get_admin_review_results('00000000-0000-0000-0000-000000000071')
  where entry_id = '00000000-0000-0000-0000-000000000076';
  if result_record.rank is not null or result_record.score is not null
     or result_record.vote_count <> 0 then
    raise exception 'An incomplete ballot contributed to preliminary results';
  end if;

  perform public.set_competition_results_schedule(
    '00000000-0000-0000-0000-000000000071', first_schedule
  );
  perform public.set_competition_results_schedule(
    '00000000-0000-0000-0000-000000000071', replacement_schedule
  );
  if (select results_publish_at from public.competitions
      where id = '00000000-0000-0000-0000-000000000071') <> replacement_schedule then
    raise exception 'Admin could not overwrite the publication schedule';
  end if;
  perform public.set_competition_results_schedule(
    '00000000-0000-0000-0000-000000000071', null
  );
  if (select results_publish_at from public.competitions
      where id = '00000000-0000-0000-0000-000000000071') is not null then
    raise exception 'Admin could not cancel the publication schedule';
  end if;

  if (select count(*) from public.get_admin_review_category_results(
      '00000000-0000-0000-0000-000000000071'
      )) <> 6
     or (select count(*) from public.get_admin_review_category_results(
       '00000000-0000-0000-0000-000000000071'
       ) as category_result where category_result.rank = 1) < 2 then
    raise exception 'Preliminary category scores or winners were not calculated';
  end if;

  begin
    perform public.publish_competition_results('00000000-0000-0000-0000-000000000071');
    raise exception 'An entry below the minimum complete-ballot count was published';
  exception when object_not_in_prerequisite_state then null;
  end;

  if (select status from public.competitions
      where id = '00000000-0000-0000-0000-000000000071') <> 'review_pending' then
    raise exception 'A failed publication partially changed competition status';
  end if;

  perform public.disqualify_competition_entry(
    '00000000-0000-0000-0000-000000000071',
    '00000000-0000-0000-0000-000000000076',
    'Incomplete ballot minimum not met',
    'bottom'
  );
  select * into result_record
  from public.get_admin_review_results('00000000-0000-0000-0000-000000000071')
  where entry_id = '00000000-0000-0000-0000-000000000076';
  if result_record.disqualification_reason <> 'Incomplete ballot minimum not met'
     or result_record.disqualified_by <> auth.uid()
     or result_record.disqualified_at is null then
    raise exception 'Disqualification audit was not retained for review';
  end if;
  if result_record.rank <> 4 or result_record.disqualification_display <> 'bottom' then
    raise exception 'Bottom-displayed disqualification was not ranked last';
  end if;

  perform public.reinstate_competition_entry(
    '00000000-0000-0000-0000-000000000071',
    '00000000-0000-0000-0000-000000000076',
    'Disqualification reviewed'
  );
  perform public.disqualify_competition_entry(
    '00000000-0000-0000-0000-000000000071',
    '00000000-0000-0000-0000-000000000076',
    'Incomplete ballot minimum not met',
    'bottom'
  );
  perform public.disqualify_competition_entry(
    '00000000-0000-0000-0000-000000000071',
    '00000000-0000-0000-0000-000000000078',
    'Content was inappropriate',
    'remove_content'
  );
  if public.can_read_submission_media(
    '00000000-0000-0000-0000-000000000071/00000000-0000-0000-0000-000000000078/00000000-0000-0000-0000-000000000079.jpg'
  ) then
    raise exception 'Removed entry media remained readable to admins';
  end if;

  if public.publish_competition_results('00000000-0000-0000-0000-000000000071') <> 3 then
    raise exception 'Publication did not snapshot all eligible entries';
  end if;
  if (select status from public.competitions
      where id = '00000000-0000-0000-0000-000000000071') <> 'results_published' then
    raise exception 'Publication did not complete the competition';
  end if;
  -- Bottom-displayed disqualifications follow the highest eligible rank,
  -- matching the admin preview: two entries tied at 1, then the disqualified one at 2.
  if (select count(*) from public.get_published_competition_results(
      '00000000-0000-0000-0000-000000000071'
      ) as result where result.rank = 1) <> 2
     or (select count(*) from public.get_published_competition_results(
       '00000000-0000-0000-0000-000000000071'
       ) as result where result.rank = 2 and result.is_disqualified
         and result.score is null) <> 1 then
    raise exception 'Published ties or disqualification filtering failed';
  end if;
  if (select count(*) from public.get_published_competition_category_results(
      '00000000-0000-0000-0000-000000000071'
      ) as category_result where category_result.rank = 1) < 2 then
    raise exception 'Published category winners were not available to group members';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000066', true);
do $$
begin
  if (select count(*) from public.get_published_competition_results(
    '00000000-0000-0000-0000-000000000071'
  )) <> 3 then
    raise exception 'A group member could not read published results';
  end if;
  if not exists (
    select 1 from public.get_published_competition_results(
      '00000000-0000-0000-0000-000000000071'
    ) as result where result.creator_id = '00000000-0000-0000-0000-000000000062'
  ) or not exists (
    select 1 from public.get_published_competition_results(
      '00000000-0000-0000-0000-000000000071'
    ) as result where result.creator_id = '00000000-0000-0000-0000-000000000063'
  ) then
    raise exception 'Published results did not reveal authorized creator identities';
  end if;
  if (select result.media_keys from public.get_published_competition_results(
      '00000000-0000-0000-0000-000000000071'
    ) as result where result.creator_id = '00000000-0000-0000-0000-000000000062')
    <> array['00000000-0000-0000-0000-000000000071/00000000-0000-0000-0000-000000000074/00000000-0000-0000-0000-000000000081.jpg']
     or not public.can_read_submission_media(
       '00000000-0000-0000-0000-000000000071/00000000-0000-0000-0000-000000000074/00000000-0000-0000-0000-000000000081.jpg'
     ) then
    raise exception 'Published entry media was not available to group members';
  end if;
  if exists (
    select 1 from public.get_published_competition_results(
      '00000000-0000-0000-0000-000000000071'
    ) as result where result.is_disqualified and cardinality(result.media_keys) > 0
  ) or public.can_read_submission_media(
    '00000000-0000-0000-0000-000000000071/00000000-0000-0000-0000-000000000076/00000000-0000-0000-0000-000000000082.jpg'
  ) then
    raise exception 'Disqualified entry media was published';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000068', true);
do $$
begin
  begin
    perform public.get_published_competition_results('00000000-0000-0000-0000-000000000071');
    raise exception 'A non-member read published identities';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
do $$
begin
  if (select count(*) from public.entries
      where id = '00000000-0000-0000-0000-000000000076') <> 1
     or (select count(*) from public.votes as vote
         where vote.entry_id = '00000000-0000-0000-0000-000000000076') <> 1
     or (select count(*) from public.entry_disqualification_events as event
         where event.entry_id = '00000000-0000-0000-0000-000000000076'
           and event.actor_id = '00000000-0000-0000-0000-000000000061') <> 3 then
    raise exception 'Disqualification, reinstatement, or audit retention failed';
  end if;
  if (select title from public.entries
     where id = '00000000-0000-0000-0000-000000000078') <> 'Content removed'
     or (select cardinality(media_keys) from public.entries
        where id = '00000000-0000-0000-0000-000000000078') <> 0 then
    raise exception 'Content-removal moderation did not sanitize the entry';
  end if;
  if (select count(*) from public.published_competition_results
      where competition_id = '00000000-0000-0000-0000-000000000071') <> 3 then
    raise exception 'Publication snapshot did not contain the eligible entries';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000061', true);
do $$
begin
  if public.transition_competition(
    '00000000-0000-0000-0000-000000000071', 'review_pending'
  ) <> 'review_pending' then
    raise exception 'Admin could not return published results to review';
  end if;
  if exists (
    select 1 from public.published_competition_results
    where competition_id = '00000000-0000-0000-0000-000000000071'
  ) or exists (
    select 1 from public.published_competition_category_results
    where competition_id = '00000000-0000-0000-0000-000000000071'
  ) then
    raise exception 'Returning to review retained published result snapshots';
  end if;
  begin
    perform public.get_published_competition_results('00000000-0000-0000-0000-000000000071');
    raise exception 'Published results remained visible after returning to review';
  exception when insufficient_privilege then null;
  end;
end;
$$;

rollback;
