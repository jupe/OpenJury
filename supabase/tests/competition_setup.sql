-- Run with psql as the database owner after applying all three migrations.
-- Fixtures and RPC-created data are rolled back.
begin;

insert into auth.users (id) values
  ('00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000003');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);

do $$
declare
  group_id uuid;
  competition_id uuid;
begin
  group_id := public.create_group('Competition setup tenant');
  competition_id := public.save_draft_competition(
    null,
    group_id,
    '  Baking challenge  ',
    'remote',
    '2026-10-10 12:00:00+00',
    '2026-10-12 12:00:00+00',
    '[{"name":"Taste","max_score":5},{"name":"Presentation","max_score":3}]'
  );

  if not exists (
    select 1 from public.competitions
    where id = competition_id
      and group_id = group_id
      and name = 'Baking challenge'
      and event_type = 'remote'
      and status = 'draft'
  ) or (select count(*) from public.categories
        where competition_id = competition_id) <> 2 then
    raise exception 'Admin competition setup did not persist';
  end if;

  if public.save_draft_competition(
       competition_id, group_id, 'Updated challenge', 'live',
       null, null, '[{"name":"Creativity","max_score":4}]'
     ) <> competition_id
     or (select name from public.competitions where id = competition_id)
       <> 'Updated challenge'
     or (select name from public.categories where competition_id = competition_id)
       <> 'Creativity' then
    raise exception 'Draft competition and scoring criteria must be editable';
  end if;

  begin
    perform public.save_draft_competition(
      null, group_id, 'Bad deadlines', 'remote',
      '2026-10-12 12:00:00+00', '2026-10-12 12:00:00+00',
      '[{"name":"Taste","max_score":5}]'
    );
    raise exception 'Invalid deadline order accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.save_draft_competition(
      null, group_id, 'Bad score', 'remote', null, null,
      '[{"name":"Taste","max_score":6}]'
    );
    raise exception 'Score maximum above five accepted';
  exception when invalid_parameter_value then null;
  end;

  begin
    insert into public.competitions (group_id, name, event_type)
    values (group_id, 'Direct write', 'live');
    raise exception 'Direct competition writes allowed';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
insert into public.group_members (group_id, user_id, role)
select id, '00000000-0000-0000-0000-000000000002', 'member'
from public.groups where name = 'Competition setup tenant';
insert into public.group_members (group_id, user_id, role)
select id, '00000000-0000-0000-0000-000000000003', 'admin'
from public.groups where name = 'Competition setup tenant';

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);

do $$
declare
  group_id uuid;
  competition_id uuid;
begin
  select id into group_id from public.groups where name = 'Competition setup tenant';
  select id into competition_id from public.competitions where name = 'Updated challenge';

  if not exists (
    select 1 from public.competitions
    where id = competition_id and group_id = group_id
  ) or (select count(*) from public.categories
        where competition_id = competition_id) <> 1 then
    raise exception 'Group members must read authorized competition setup';
  end if;

  begin
    perform public.save_draft_competition(
      null, group_id, 'Member draft', 'live', null, null,
      '[{"name":"Taste","max_score":5}]'
    );
    raise exception 'Group member created a competition';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', true);
do $$
declare
  competition_id uuid;
  group_id uuid;
begin
  select id into competition_id from public.competitions where name = 'Updated challenge';
  select id into group_id from public.groups where name = 'Competition setup tenant';
  update public.competitions set status = 'submission' where id = competition_id;

  begin
    perform public.save_draft_competition(
      competition_id, group_id, 'Changed after opening', 'live',
      null, null, '[{"name":"New score","max_score":5}]'
    );
    raise exception 'Non-draft competition was editable';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

reset role;
do $$
begin
  if exists (select 1 from public.competitions)
     or exists (select 1 from public.categories) then
    raise exception 'Test data should be isolated to this transaction';
  end if;
end;
$$;

rollback;
