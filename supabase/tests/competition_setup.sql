-- Run with psql as the database owner after applying all migrations.
-- Fixtures and RPC-created data are rolled back.
begin;

insert into auth.users (id) values
  ('00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000003'),
  ('00000000-0000-0000-0000-000000000004');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);

do $$
declare
  v_group_id uuid;
  v_competition_id uuid;
  v_publish_at timestamptz := clock_timestamp() + interval '1 day';
begin
  v_group_id := public.create_group('Competition setup tenant');
  v_competition_id := public.save_draft_competition(
    null,
    v_group_id,
    '  Baking challenge  ',
    'remote',
    '2026-10-10 12:00:00+00',
    '2026-10-12 12:00:00+00',
    '[{"name":"Taste","max_score":5},{"name":"Presentation","max_score":3}]',
    '  Bring your best bake.  ', '  No store-bought entries.  ', false, 12,
    p_results_publish_at => v_publish_at
  );

  if not exists (
    select 1 from public.competitions as competition
    where competition.id = v_competition_id
      and competition.group_id = v_group_id
      and competition.name = 'Baking challenge'
      and competition.event_type = 'remote'
      and competition.status = 'draft'
      and competition.max_submission_images = 12
      and competition.submission_type = 'photo'
      and competition.description = 'Bring your best bake.'
      and competition.rules = 'No store-bought entries.'
      and competition.results_publish_at = v_publish_at
  ) or (select count(*) from public.categories
        where categories.competition_id = v_competition_id) <> 2 then
    raise exception 'Admin competition setup did not persist';
  end if;

  if public.save_draft_competition(
       v_competition_id, v_group_id, 'Updated challenge', 'live',
       null, null, '[{"name":"Creativity","max_score":4}]',
       null, null, false, 7
     ) <> v_competition_id
  then
    raise exception 'Draft save must return the competition ID';
  end if;
  if (select name from public.competitions where id = v_competition_id)
       <> 'Updated challenge'
     or (select name from public.categories where categories.competition_id = v_competition_id)
       <> 'Creativity'
     or (select max_submission_images from public.competitions where id = v_competition_id)
       <> 7
     or (select results_publish_at from public.competitions where id = v_competition_id)
       is not null
     or exists (
       select 1 from public.competitions where id = v_competition_id
        and (description is not null or rules is not null)
     ) then
    raise exception 'Draft competition and scoring criteria must be editable';
  end if;

  begin
    perform public.save_draft_competition(
      null, v_group_id, 'Bad deadlines', 'remote',
      '2026-10-12 12:00:00+00', '2026-10-12 12:00:00+00',
      '[{"name":"Taste","max_score":5}]'
    );
    raise exception 'Invalid deadline order accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.save_draft_competition(
      v_competition_id, v_group_id, 'Updated challenge', 'live',
      null, null, '[{"name":"Creativity","max_score":4}]',
      p_results_publish_at => clock_timestamp() - interval '1 second'
    );
    raise exception 'Past results publication time accepted for a draft';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.save_draft_competition(
      v_competition_id, v_group_id, 'Updated challenge', 'live',
      null, null, '[{"name":"Creativity","max_score":4}]',
      null, null, false, 21
    );
    raise exception 'Invalid photo limit accepted for a draft';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.save_draft_competition(
      v_competition_id, v_group_id, 'Updated challenge', 'live',
      null, null, '[{"name":"Creativity","max_score":4}]',
      p_submission_type => 'video'
    );
    raise exception 'Invalid submission type accepted for a draft';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.save_draft_competition(
      null, v_group_id, 'Bad score', 'remote', null, null,
      '[{"name":"Taste","max_score":6}]'
    );
    raise exception 'Score maximum above five accepted';
  exception when invalid_parameter_value then null;
  end;

  begin
    insert into public.competitions (group_id, name, event_type)
    values (v_group_id, 'Direct write', 'live');
    raise exception 'Direct competition writes allowed';
  exception when insufficient_privilege then null;
  end;
end;
$$;

do $$
declare
  v_competition_id uuid;
  v_group_id uuid;
  invalid_details record;
  before_competition jsonb;
  before_categories jsonb;
begin
  select id, group_id into v_competition_id, v_group_id
    from public.competitions where name = 'Updated challenge';
  perform set_config('test.competition_id', v_competition_id::text, true);
  perform set_config('test.group_id', v_group_id::text, true);

  perform public.save_draft_competition(
    v_competition_id, v_group_id, 'Updated challenge', 'live',
    null, null, '[{"name":"Creativity","max_score":4}]',
    null, null, false, 7,
    '  New description  ', '  New rules  '
  );
  if not exists (
    select 1 from public.competitions where id = v_competition_id
      and description = 'New description' and rules = 'New rules'
  ) then
    raise exception 'Draft details were not updated atomically';
  end if;

  select to_jsonb(c) into before_competition from public.competitions c
    where id = v_competition_id;
  select jsonb_agg(to_jsonb(c) order by id) into before_categories
    from public.categories c where competition_id = v_competition_id;
  for invalid_details in
    select * from (values
      (null::text, 'Description', 'Rules'),
      ('   ', 'Description', 'Rules'),
      (repeat('n', 101), 'Description', 'Rules'),
      ('Valid name', repeat('d', 10001), 'Rules'),
      ('Valid name', 'Description', repeat('r', 10001))
    ) as cases(name, description, rules)
  loop
    begin
      perform public.save_competition_details(
        v_competition_id, invalid_details.name,
        invalid_details.description, invalid_details.rules
      );
      raise exception 'Invalid competition details accepted';
    exception when invalid_parameter_value then null;
    end;
    begin
      perform public.save_draft_competition(
        v_competition_id, v_group_id, invalid_details.name, 'remote',
        null, null, '[{"name":"Replacement","max_score":5}]',
        invalid_details.description, invalid_details.rules
      );
      raise exception 'Invalid draft update accepted';
    exception when invalid_parameter_value then null;
    end;
    begin
      perform public.save_draft_competition(
        null, v_group_id, invalid_details.name, 'live',
        null, null, '[{"name":"Taste","max_score":5}]',
        invalid_details.description, invalid_details.rules
      );
      raise exception 'Invalid draft creation accepted';
    exception when invalid_parameter_value then null;
    end;
  end loop;
  if (select to_jsonb(c) from public.competitions c where id = v_competition_id)
       is distinct from before_competition
     or (select jsonb_agg(to_jsonb(c) order by id) from public.categories c
         where competition_id = v_competition_id) is distinct from before_categories then
    raise exception 'Rejected details changed competition or categories';
  end if;

  perform public.save_draft_competition(
    v_competition_id, v_group_id, ' ' || repeat('n', 100) || ' ', 'live',
    null, null, '[{"name":"Creativity","max_score":4}]',
    ' ' || repeat('é', 10000) || ' ', ' ' || repeat('r', 10000) || ' '
  );
  if not exists (
    select 1 from public.competitions where id = v_competition_id
      and char_length(name) = 100 and char_length(description) = 10000
      and char_length(rules) = 10000 and max_submission_images = 7
  ) then
    raise exception 'Draft boundary lengths or trimming failed';
  end if;
  perform public.save_draft_competition(
    v_competition_id, v_group_id, 'Updated challenge', 'live',
    null, null, '[{"name":"Creativity","max_score":4}]', '   ', ''
  );
  if exists (
    select 1 from public.competitions where id = v_competition_id
      and (description is not null or rules is not null)
  ) then
    raise exception 'Blank draft details were not cleared';
  end if;

  if public.save_competition_details(
    v_competition_id, ' ' || repeat('n', 100) || ' ',
    ' ' || repeat('é', 10000) || ' ', ' ' || repeat('r', 10000) || ' ', 11
  ) is distinct from v_competition_id then
    raise exception 'Metadata save must return the competition ID';
  end if;
  if not exists (
    select 1 from public.competitions where id = v_competition_id
      and char_length(name) = 100 and char_length(description) = 10000
      and char_length(rules) = 10000 and max_submission_images = 11
  ) then
    raise exception 'Metadata boundary lengths or return ID failed';
  end if;
  begin
    perform public.save_competition_details(
      v_competition_id, 'Invalid photo limit', null, null, 0
    );
    raise exception 'Invalid photo limit accepted for competition details';
  exception when invalid_parameter_value then null;
  end;
  perform public.save_competition_details(v_competition_id, 'x', '   ', '');
  if exists (
    select 1 from public.competitions where id = v_competition_id
      and (description is not null or rules is not null)
  ) then
    raise exception 'Blank competition details were not cleared';
  end if;
  perform public.save_competition_details(v_competition_id, 'x', 'Description', 'Rules');
  perform public.save_competition_details(v_competition_id, 'Updated challenge', null, null);
  if exists (
    select 1 from public.competitions where id = v_competition_id
      and (description is not null or rules is not null)
  ) then
    raise exception 'Null competition details were not cleared';
  end if;

  begin
    perform public.save_competition_details(
      '00000000-0000-0000-0000-000000000099', 'Missing', null, null
    );
    raise exception 'Missing competition accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.competitions set description = 'Direct write' where id = v_competition_id;
    raise exception 'Direct metadata writes allowed';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000004', true);
do $$
begin
  if exists (select 1 from public.competitions)
     or exists (select 1 from public.categories) then
    raise exception 'A non-member can read another tenant competition';
  end if;
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
  v_group_id uuid;
  v_competition_id uuid;
begin
  select id into v_group_id from public.groups where name = 'Competition setup tenant';
  select id into v_competition_id from public.competitions where name = 'Updated challenge';

  if not exists (
    select 1 from public.competitions as competition
    where competition.id = v_competition_id and competition.group_id = v_group_id
  ) or (select count(*) from public.categories
        where categories.competition_id = v_competition_id) <> 1 then
    raise exception 'Group members must read authorized competition setup';
  end if;

  begin
    perform public.save_draft_competition(
      null, v_group_id, 'Member draft', 'live', null, null,
      '[{"name":"Taste","max_score":5}]'
    );
    raise exception 'Group member created a competition';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', true);
reset role;
update public.competitions
set status = 'submission'
where name = 'Updated challenge';
set local role authenticated;
do $$
declare
  v_competition_id uuid;
  v_group_id uuid;
begin
  select id into v_competition_id from public.competitions where name = 'Updated challenge';
  select id into v_group_id from public.groups where name = 'Competition setup tenant';

  begin
    perform public.save_draft_competition(
      v_competition_id, v_group_id, 'Changed after opening', 'live',
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
  if (select count(*) from public.competitions) <> 1
     or (select count(*) from public.categories) <> 1 then
    raise exception 'Unexpected competition setup test rows';
  end if;
end;
$$;

-- Metadata edits must not change any other column or scoring criterion in any phase.
do $$
declare
  v_competition_id uuid := current_setting('test.competition_id')::uuid;
  phase text;
  before_competition jsonb;
  before_categories jsonb;
begin
  foreach phase in array array['draft', 'submission', 'voting', 'review_pending', 'results_published']
  loop
    update public.competitions
      set status = phase,
          submission_deadline = '2026-10-10 12:00:00+00',
          voting_deadline = '2026-10-12 12:00:00+00',
          results_publish_at = '2026-10-13 12:00:00+00'
      where id = v_competition_id;
    select to_jsonb(c) - array['name', 'description', 'rules'] into before_competition
      from public.competitions c where id = v_competition_id;
    select jsonb_agg(to_jsonb(c) order by id) into before_categories
      from public.categories c where competition_id = v_competition_id;

    set local role authenticated;
    perform public.save_competition_details(
      v_competition_id, '  Edited in ' || phase || '  ', '  Description  ', '  Rules  '
    );
    if not exists (
      select 1 from public.competitions where id = v_competition_id
        and name = 'Edited in ' || phase and description = 'Description' and rules = 'Rules'
    ) or (select to_jsonb(c) - array['name', 'description', 'rules']
          from public.competitions c where id = v_competition_id)
          is distinct from before_competition
       or (select jsonb_agg(to_jsonb(c) order by id) from public.categories c
           where competition_id = v_competition_id) is distinct from before_categories then
      raise exception 'Metadata edit changed protected fields in phase %', phase;
    end if;
    reset role;
  end loop;

  begin
    update public.competitions set description = repeat('d', 10001) where id = v_competition_id;
    raise exception 'Table accepted oversized description';
  exception when check_violation then null;
  end;
  begin
    update public.competitions set rules = repeat('r', 10001) where id = v_competition_id;
    raise exception 'Table accepted oversized rules';
  exception when check_violation then null;
  end;
end;
$$;

-- Revoke the second admin, then test current membership rather than stale JWT claims.
delete from public.group_members
where group_id = current_setting('test.group_id')::uuid
  and user_id = '00000000-0000-0000-0000-000000000003';
update public.competitions set status = 'draft'
where id = current_setting('test.competition_id')::uuid;
set local role authenticated;
do $$
declare
  actor text;
  v_competition_id uuid := current_setting('test.competition_id')::uuid;
  v_group_id uuid := current_setting('test.group_id')::uuid;
begin
  foreach actor in array array[
    '', -- authenticated role without a user
    '00000000-0000-0000-0000-000000000002', -- member
    '00000000-0000-0000-0000-000000000004', -- outsider
    '00000000-0000-0000-0000-000000000003'  -- revoked admin
  ]
  loop
    perform set_config('request.jwt.claim.sub', actor, true);
    begin
      perform public.save_competition_details(v_competition_id, 'Forbidden', 'Description', 'Rules');
      raise exception 'Unauthorized metadata edit by %', actor;
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.save_draft_competition(
        v_competition_id, v_group_id, 'Forbidden', 'live', null, null,
        '[{"name":"Taste","max_score":5}]', 'Description', 'Rules'
      );
      raise exception 'Unauthorized draft edit by %', actor;
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.save_draft_competition(
        null, v_group_id, 'Forbidden', 'live', null, null,
        '[{"name":"Taste","max_score":5}]', 'Description', 'Rules'
      );
      raise exception 'Unauthorized draft creation by %', actor;
    exception when insufficient_privilege then null;
    end;
  end loop;
end;
$$;

reset role;
set local role anon;
do $$
begin
  begin
    perform public.save_competition_details(
      current_setting('test.competition_id')::uuid, 'Anonymous edit', null, null
    );
    raise exception 'Anonymous metadata execution allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.save_draft_competition(
      null, current_setting('test.group_id')::uuid, 'Anonymous draft', 'live',
      null, null, '[{"name":"Taste","max_score":5}]', 'Description', 'Rules'
    );
    raise exception 'Anonymous draft execution allowed';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
do $$
begin
  if (select count(*) from pg_proc
      where pronamespace = 'public'::regnamespace and proname = 'save_draft_competition') <> 1
     or to_regprocedure('public.save_draft_competition(uuid,uuid,text,text,timestamptz,timestamptz,jsonb)')
        is not null then
    raise exception 'Draft RPC must not be overloaded';
  end if;
  if not exists (
    select 1 from pg_proc
    where oid = 'public.save_competition_details(uuid,text,text,text,integer)'::regprocedure
      and prosecdef and proconfig @> array['search_path=""']
      and lower(prosrc) like '%for update%'
  ) then
    raise exception 'Metadata RPC must be security definer, empty search path, and row locked';
  end if;
end;
$$;

rollback;
