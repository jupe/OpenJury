-- Run as the database owner after all migrations. All fixtures roll back.
begin;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-000000000201', 'owner@example.invalid', now()),
  ('00000000-0000-0000-0000-000000000202', 'platform@example.invalid', now()),
  ('00000000-0000-0000-0000-000000000203', 'invited@example.invalid', null),
  ('00000000-0000-0000-0000-000000000204', 'audience@example.invalid', now()),
  ('00000000-0000-0000-0000-000000000205', 'outsider@example.invalid', now());
insert into public.platform_admins (email) values ('platform@example.invalid');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000201', true);
select set_config('test.group', public.create_group('Authorization tenant')::text, true);
select set_config('test.other_group', public.create_group('Other tenant')::text, true);
select set_config('test.token', public.create_group_invite(current_setting('test.group')::uuid), true);
select public.invite_group_member_by_email(current_setting('test.group')::uuid, ' INVITED@example.invalid ');

do $$
begin
  if (select count(*) from public.get_group_email_invites(current_setting('test.group')::uuid)) <> 1
     or (select email from public.get_group_email_invites(current_setting('test.group')::uuid))
       <> 'invited@example.invalid' then
    raise exception 'Admin email invitation normalization failed';
  end if;
  begin
    perform public.set_group_member_role(current_setting('test.group')::uuid, auth.uid(), 'member');
    raise exception 'Last admin was demoted';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform public.remove_group_member(current_setting('test.group')::uuid, auth.uid());
    raise exception 'Last admin was removed';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

-- JWT email claims cannot substitute for the confirmed auth.users address.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000203', true);
select set_config('request.jwt.claim.email', 'platform@example.invalid', true);
do $$
begin
  if public.is_platform_admin() or public.claim_group_invites() <> 0 then
    raise exception 'Unconfirmed account claimed an invitation or spoofed platform access';
  end if;
end;
$$;
reset role;
update auth.users set email_confirmed_at = now()
where id = '00000000-0000-0000-0000-000000000203';
set local role authenticated;
do $$
begin
  if public.claim_group_invites() <> 1 or public.claim_group_invites() <> 0
     or public.is_group_admin(current_setting('test.group')::uuid) then
    raise exception 'Confirmed invitation must create one non-admin membership';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000204', true);
do $$
begin
  if (select group_id from public.get_group_invite(current_setting('test.token')))
       is distinct from current_setting('test.group')::uuid
     or public.accept_group_invite(current_setting('test.token'))
       is distinct from current_setting('test.group')::uuid
     or public.accept_group_invite(current_setting('test.token'))
       is distinct from current_setting('test.group')::uuid
     or public.is_group_admin(current_setting('test.group')::uuid) then
    raise exception 'Link invitation must be idempotent and never promote';
  end if;
end;
$$;

-- Members and outsiders cannot administer memberships, invites or the platform.
do $$
declare
  actor text;
  statement text;
begin
  foreach actor in array array[
    '00000000-0000-0000-0000-000000000203',
    '00000000-0000-0000-0000-000000000205',
    ''
  ] loop
    perform set_config('request.jwt.claim.sub', actor, true);
    foreach statement in array array[
      'select public.get_platform_groups()',
      'select public.platform_admin_join_group(current_setting(''test.group'')::uuid)',
      'select public.get_group_members(current_setting(''test.group'')::uuid)',
      'select public.set_group_member_role(current_setting(''test.group'')::uuid, auth.uid(), ''admin'')',
      'select public.remove_group_member(current_setting(''test.group'')::uuid, auth.uid())',
      'select public.create_group_invite(current_setting(''test.group'')::uuid)',
      'select public.get_group_invite_links(current_setting(''test.group'')::uuid)',
      'select public.get_group_email_invites(current_setting(''test.group'')::uuid)',
      'select public.invite_group_member_by_email(current_setting(''test.group'')::uuid, ''attacker@example.invalid'')',
      'select public.revoke_group_email_invite(current_setting(''test.group'')::uuid, ''invited@example.invalid'')',
      'select email from public.platform_admins',
      'select token from public.group_invites',
      'insert into public.competition_participants values (gen_random_uuid(), auth.uid(), ''audience'', now())'
    ] loop
      begin
        execute statement;
        raise exception 'Forbidden operation succeeded for %: %', actor, statement;
      exception when insufficient_privilege then null;
      end;
    end loop;
  end loop;
end;
$$;

reset role;
update auth.users set email_confirmed_at = null
where id = '00000000-0000-0000-0000-000000000202';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
do $$
begin
  if public.is_platform_admin() then
    raise exception 'Unconfirmed configured platform email grants administration';
  end if;
  begin
    perform public.get_platform_groups();
    raise exception 'Unconfirmed platform account listed groups';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
update auth.users set email_confirmed_at = now()
where id = '00000000-0000-0000-0000-000000000202';
set local role authenticated;
do $$
begin
  if not public.is_platform_admin()
     or (select count(*) from public.get_platform_groups()) <> 2 then
    raise exception 'Confirmed configured platform admin cannot list groups';
  end if;
  -- Platform access alone does not confer group-level administration.
  begin
    perform public.create_group_invite(current_setting('test.group')::uuid);
    raise exception 'Platform admin bypassed explicit group takeover';
  exception when insufficient_privilege then null;
  end;
  perform public.platform_admin_join_group(current_setting('test.group')::uuid);
  perform public.platform_admin_join_group(current_setting('test.group')::uuid);
  if not public.is_group_admin(current_setting('test.group')::uuid) then
    raise exception 'Platform takeover did not grant group admin';
  end if;
  perform public.set_group_member_role(current_setting('test.group')::uuid,
    '00000000-0000-0000-0000-000000000203', 'admin');
  perform public.set_group_member_role(current_setting('test.group')::uuid,
    '00000000-0000-0000-0000-000000000203', 'member');
  if (select count(*) from public.get_group_members(current_setting('test.group')::uuid)) <> 4 then
    raise exception 'Admin membership roster is incomplete';
  end if;
  perform public.invite_group_member_by_email(current_setting('test.group')::uuid, 'outsider@example.invalid');
  perform public.revoke_group_email_invite(current_setting('test.group')::uuid, ' OUTSIDER@example.invalid ');
  begin
    perform public.create_group_invite(current_setting('test.other_group')::uuid);
    raise exception 'Group admin created an invitation for another tenant';
  exception when insufficient_privilege then null;
  end;
  perform public.revoke_group_invite((select id from
    public.get_group_invite_links(current_setting('test.group')::uuid)
    where token = current_setting('test.token')));
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000205', true);
do $$
begin
  if public.claim_group_invites() <> 0 then
    raise exception 'Revoked email invitation was claimed';
  end if;
  if exists (select 1 from public.get_group_invite(current_setting('test.token'))) then
    raise exception 'Revoked invite remains visible';
  end if;
  begin
    perform public.accept_group_invite(current_setting('test.token'));
    raise exception 'Revoked link accepted';
  exception when invalid_parameter_value then null;
  end;
end;
$$;
reset role;
delete from public.platform_admins;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
do $$
begin
  if public.is_platform_admin() then
    raise exception 'Removed platform configuration still grants access';
  end if;
end;
$$;

-- Exercise the current participant/audience RPCs, not obsolete cast_vote.
select set_config('test.competition', public.save_draft_competition(
  null, current_setting('test.group')::uuid, 'Role competition', 'live', null, null,
  '[{"name":"Taste","max_score":5}]'
)::text, true);
select public.transition_competition(current_setting('test.competition')::uuid, 'submission');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000203', true);
select public.join_competition(current_setting('test.competition')::uuid, 'participant');
select public.join_competition(current_setting('test.competition')::uuid, 'participant');
select public.save_submission(current_setting('test.competition')::uuid, null, 'Entry', '{}');
do $$
begin
  begin
    perform public.join_competition(current_setting('test.competition')::uuid, 'audience');
    raise exception 'Entry owner switched to audience';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform public.save_ballot(current_setting('test.competition')::uuid, 1, '[]');
    raise exception 'Participant voted';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_competition_participants(current_setting('test.competition')::uuid);
    raise exception 'Member read other participant identities';
  exception when insufficient_privilege then null;
  end;
end;
$$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000204', true);
select public.join_competition(current_setting('test.competition')::uuid, 'audience');
do $$
begin
  begin
    perform public.save_submission(current_setting('test.competition')::uuid, null, 'Forbidden', '{}');
    raise exception 'Audience submitted an entry';
  exception when insufficient_privilege then null;
  end;
end;
$$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select public.transition_competition(current_setting('test.competition')::uuid, 'voting');
do $$
begin
  if (select count(*) from public.get_competition_participants(current_setting('test.competition')::uuid)) <> 2 then
    raise exception 'Admin participant roster is incomplete';
  end if;
end;
$$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000204', true);
do $$
begin
  perform public.save_ballot(current_setting('test.competition')::uuid,
    (select entry_number from public.get_blind_voting_entries(current_setting('test.competition')::uuid)),
    (select jsonb_agg(jsonb_build_object('category_id', id, 'score', 4))
      from public.categories where competition_id = current_setting('test.competition')::uuid));
  begin
    perform public.join_competition(current_setting('test.competition')::uuid, 'participant');
    raise exception 'Audience switched after voting began';
  exception when object_not_in_prerequisite_state then null;
  end;
  if (select count(*) from public.competition_participants) <> 1 then
    raise exception 'RLS exposed other users competition roles';
  end if;
end;
$$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000205', true);
do $$
begin
  begin
    perform public.join_competition(current_setting('test.competition')::uuid, 'audience');
    raise exception 'Outsider joined competition';
  exception when insufficient_privilege then null;
  end;
end;
$$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000201', true);
do $$
begin
  begin
    perform public.join_competition(current_setting('test.competition')::uuid, 'participant');
    raise exception 'New participant joined during voting';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform public.join_competition(current_setting('test.competition')::uuid, 'admin');
    raise exception 'Invalid competition role accepted';
  exception when invalid_parameter_value then null;
  end;
end;
$$;
reset role;
set local role anon;
do $$
declare
  statement text;
begin
  foreach statement in array array[
    'select public.get_platform_groups()',
    'select public.create_group_invite(current_setting(''test.group'')::uuid)',
    'select public.get_group_invite(current_setting(''test.token''))',
    'select public.accept_group_invite(current_setting(''test.token''))',
    'select public.claim_group_invites()',
    'select public.join_competition(current_setting(''test.competition'')::uuid, ''audience'')',
    'select public.save_submission(current_setting(''test.competition'')::uuid, null, ''Forbidden'', ''{}'')',
    'select public.save_ballot(current_setting(''test.competition'')::uuid, 1, ''[]'')'
  ] loop
    begin
      execute statement;
      raise exception 'Anonymous execution succeeded: %', statement;
    exception when insufficient_privilege then null;
    end;
  end loop;
end;
$$;
reset role;
rollback;
