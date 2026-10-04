-- Run with psql as the database owner after applying all migrations.
-- Fixtures and RPC-created data are rolled back.
begin;

insert into auth.users (id) values
  ('00000000-0000-0000-0000-000000000031'),
  ('00000000-0000-0000-0000-000000000032'),
  ('00000000-0000-0000-0000-000000000033'),
  ('00000000-0000-0000-0000-000000000034');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);

do $$
begin
  perform public.create_group('Transactional lifecycle tenant');
end;
$$;

reset role;
insert into public.group_members (group_id, user_id, role)
select id, '00000000-0000-0000-0000-000000000032', 'member'
from public.groups where name = 'Transactional lifecycle tenant';
insert into public.group_members (group_id, user_id, role)
select id, '00000000-0000-0000-0000-000000000034', 'member'
from public.groups where name = 'Transactional lifecycle tenant';
insert into public.competitions (
  id, group_id, name, event_type, submission_deadline, voting_deadline
)
select
  '00000000-0000-0000-0000-000000000041',
  id,
  'Remote lifecycle',
  'remote',
  clock_timestamp() + interval '1 hour',
  clock_timestamp() + interval '2 hours'
from public.groups where name = 'Transactional lifecycle tenant';
insert into public.competitions (id, group_id, name, event_type)
select
  '00000000-0000-0000-0000-000000000042',
  id,
  'Live lifecycle',
  'live'
from public.groups where name = 'Transactional lifecycle tenant';
insert into public.categories (competition_id, name, max_score)
select id, 'Taste', 5 from public.competitions
where id in (
  '00000000-0000-0000-0000-000000000041',
  '00000000-0000-0000-0000-000000000042'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
do $$
begin
  if public.transition_competition(
    '00000000-0000-0000-0000-000000000041', 'submission'
  ) <> 'submission' then
    raise exception 'Admin could not open submissions';
  end if;
  if public.transition_competition(
    '00000000-0000-0000-0000-000000000042', 'submission'
  ) <> 'submission' then
    raise exception 'Admin could not open live submissions';
  end if;

  if public.transition_competition(
    '00000000-0000-0000-0000-000000000042', 'voting'
  ) <> 'voting' then
    raise exception 'Admin could not open live voting';
  end if;
  if public.transition_competition(
    '00000000-0000-0000-0000-000000000042', 'review_pending'
  ) <> 'review_pending' then
    raise exception 'Admin could not start live review';
  end if;
  if public.transition_competition(
    '00000000-0000-0000-0000-000000000042', 'completed'
  ) <> 'completed' then
    raise exception 'Admin could not complete the live lifecycle';
  end if;

  begin
    perform public.transition_competition(
      '00000000-0000-0000-0000-000000000042', 'draft'
    );
    raise exception 'Invalid backward transition was accepted';
  exception when object_not_in_prerequisite_state then null;
  end;

  begin
    perform public.transition_competition(
      '00000000-0000-0000-0000-000000000041', null
    );
    raise exception 'A null target status was accepted';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000032', true);
do $$
begin
  begin
    perform public.transition_competition(
      '00000000-0000-0000-0000-000000000041', 'voting'
    );
    raise exception 'A regular member transitioned a competition';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.process_remote_competition_deadlines();
    raise exception 'An authenticated member processed remote deadlines';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select public.save_submission(
  '00000000-0000-0000-0000-000000000041', null, 'First entry', '{}'
);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000034', true);
select public.save_submission(
  '00000000-0000-0000-0000-000000000041', null, 'Second entry', '{}'
);

reset role;
update public.competitions
set submission_deadline = clock_timestamp() - interval '1 second'
where id = '00000000-0000-0000-0000-000000000041';
do $$
declare
  processed_count integer;
begin
  processed_count := public.process_remote_competition_deadlines();
  if processed_count <> 1 then
    raise exception 'Remote submission deadline did not transition exactly once';
  end if;
  processed_count := public.process_remote_competition_deadlines();
  if processed_count <> 0 then
    raise exception 'Remote submission deadline processing was not idempotent';
  end if;
end;
$$;

create temporary table lifecycle_entry_number_snapshot as
select id, random_number
from public.entries
where competition_id = '00000000-0000-0000-0000-000000000041';

do $$
begin
  if (select count(*) from lifecycle_entry_number_snapshot) <> 2
     or (select count(distinct random_number) from lifecycle_entry_number_snapshot) <> 2
     or exists (
       select 1 from lifecycle_entry_number_snapshot
       where random_number is null or random_number < 1
     ) then
    raise exception 'Voting did not assign unique positive entry numbers';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000032', true);
do $$
declare
  entry_number bigint;
begin
  select voting_entry.entry_number into entry_number
  from public.get_blind_voting_entries(
    '00000000-0000-0000-0000-000000000041'
  ) as voting_entry
  limit 1;

  perform public.cast_vote(
    '00000000-0000-0000-0000-000000000041',
    entry_number,
    (select category.id from public.categories as category
      where category.competition_id = '00000000-0000-0000-0000-000000000041'),
    4
  );
  perform public.cast_vote(
    '00000000-0000-0000-0000-000000000041',
    entry_number,
    (select category.id from public.categories as category
      where category.competition_id = '00000000-0000-0000-0000-000000000041'),
    3
  );

  begin
    perform public.cast_vote(
      '00000000-0000-0000-0000-000000000041',
      entry_number,
      (select category.id from public.categories as category
        where category.competition_id = '00000000-0000-0000-0000-000000000041'),
      6
    );
    raise exception 'A score above the category maximum was accepted';
  exception when invalid_parameter_value then null;
  end;

  begin
    perform public.cast_vote(
      '00000000-0000-0000-0000-000000000041',
      entry_number,
      (select category.id from public.categories as category
        where category.competition_id = '00000000-0000-0000-0000-000000000042'),
      3
    );
    raise exception 'A category from another competition was accepted';
  exception when invalid_parameter_value then null;
  end;
end;
$$;

reset role;
do $$
begin
  if (select count(*) from public.votes) <> 1
     or (select score from public.votes) <> 3
     or exists (
       select 1
       from public.entries as entry
       join lifecycle_entry_number_snapshot as snapshot on snapshot.id = entry.id
       where entry.random_number is distinct from snapshot.random_number
     ) then
    raise exception 'Vote updates or stable entry numbering failed';
  end if;
  if public.process_remote_competition_deadlines() <> 0 then
    raise exception 'An unexpired voting deadline was processed';
  end if;
end;
$$;

update public.competitions
set voting_deadline = clock_timestamp() - interval '1 second'
where id = '00000000-0000-0000-0000-000000000041';
do $$
declare
  processed_count integer;
begin
  processed_count := public.process_remote_competition_deadlines();
  if processed_count <> 1 then
    raise exception 'Remote voting deadline did not transition exactly once';
  end if;
  processed_count := public.process_remote_competition_deadlines();
  if processed_count <> 0
     or (select status from public.competitions
         where id = '00000000-0000-0000-0000-000000000041') <> 'review_pending' then
    raise exception 'Remote voting deadline processing was not idempotent';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000032', true);
do $$
begin
  begin
    perform public.cast_vote(
      '00000000-0000-0000-0000-000000000041',
      1,
      (select category.id from public.categories as category
        where category.competition_id = '00000000-0000-0000-0000-000000000041'),
      3
    );
    raise exception 'A vote after the deadline was accepted';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
do $$
begin
  if public.transition_competition(
    '00000000-0000-0000-0000-000000000041', 'completed'
  ) <> 'completed' then
    raise exception 'Admin could not complete a reviewed competition';
  end if;

  begin
    insert into public.votes (entry_id, voter_id, category_id, score)
    values (
      '00000000-0000-0000-0000-000000000099',
      auth.uid(),
      '00000000-0000-0000-0000-000000000099',
      1
    );
    raise exception 'Direct vote writes were allowed';
  exception when insufficient_privilege then null;
  end;
end;
$$;

rollback;
