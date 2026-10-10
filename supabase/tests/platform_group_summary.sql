-- Run with psql as the database owner after applying all migrations.
begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000003101', 'platform@example.invalid', '{}'),
  ('00000000-0000-0000-0000-000000003102', 'creator@example.invalid', '{"display_name":"  Creator Name  ","full_name":"Ignored"}'),
  ('00000000-0000-0000-0000-000000003103', 'unnamed@example.invalid', '{}'),
  ('00000000-0000-0000-0000-000000003104', 'fallback@example.invalid', '{"display_name":" ","full_name":" Full Name "}');
insert into public.platform_admins (email) values ('platform@example.invalid');
insert into public.groups (id, name, created_by, created_at) values
  ('00000000-0000-0000-0000-000000003111', 'Summary group', '00000000-0000-0000-0000-000000003102', '2026-01-02T03:04:00Z'),
  ('00000000-0000-0000-0000-000000003112', 'Empty group', '00000000-0000-0000-0000-000000003103', now()),
  ('00000000-0000-0000-0000-000000003113', 'Fallback group', '00000000-0000-0000-0000-000000003104', now());
insert into public.group_members (group_id, user_id, role) values
  ('00000000-0000-0000-0000-000000003111', '00000000-0000-0000-0000-000000003102', 'admin'),
  ('00000000-0000-0000-0000-000000003111', '00000000-0000-0000-0000-000000003103', 'member');
insert into public.competitions (group_id, name, event_type, status)
select '00000000-0000-0000-0000-000000003111', state, 'live', state
from unnest(array['draft', 'draft', 'submission', 'voting', 'review_pending', 'results_published']) as state;
insert into public.competitions (group_id, name, event_type, status) values
  ('00000000-0000-0000-0000-000000003113', 'Other tenant', 'live', 'voting');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000003101', true);
do $$
begin
  if not exists (
    select 1 from public.get_platform_groups()
    where id = '00000000-0000-0000-0000-000000003111'
      and creator_name = 'Creator Name' and creator_email = 'creator@example.invalid'
      and created_at = '2026-01-02T03:04:00Z'::timestamptz
      and member_count = 2 and admin_count = 1 and my_role is null
      and competition_count = 6
      and competition_status_counts = '{"draft":2,"submission":1,"voting":1,"review_pending":1,"results_published":1}'::jsonb
  ) then raise exception 'Platform summary incorrect or counts multiplied'; end if;
  if not exists (
    select 1 from public.get_platform_groups()
    where id = '00000000-0000-0000-0000-000000003112'
      and creator_name is null and creator_email = 'unnamed@example.invalid'
      and competition_count = 0 and competition_status_counts = '{}'::jsonb
      and member_count = 0 and admin_count = 0
  ) then raise exception 'Empty group or unnamed creator lost'; end if;
  if not exists (
    select 1 from public.get_platform_groups()
    where id = '00000000-0000-0000-0000-000000003113'
      and creator_name = 'Full Name' and competition_count = 1
      and competition_status_counts = '{"voting":1}'::jsonb
  ) then raise exception 'Creator name fallback or tenant counts incorrect'; end if;
  if exists (select 1 from public.groups where id = '00000000-0000-0000-0000-000000003111') then
    raise exception 'Platform overview bypassed direct group RLS';
  end if;
end;
$$;

-- Neither group admins nor members may read the platform-wide identities.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000003102', true);
do $$
begin
  begin
    perform public.get_platform_groups();
    raise exception 'Group admin could read platform summaries';
  exception when insufficient_privilege then null;
  end;
end;
$$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000003103', true);
do $$
begin
  begin
    perform public.get_platform_groups();
    raise exception 'Member could read platform summaries';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
update auth.users set email_confirmed_at = null where id = '00000000-0000-0000-0000-000000003101';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000003101', true);
do $$
begin
  begin
    perform public.get_platform_groups();
    raise exception 'Unconfirmed platform email could read summaries';
  exception when insufficient_privilege then null;
  end;
end;
$$;
set local role anon;
do $$
begin
  begin
    perform public.get_platform_groups();
    raise exception 'Anonymous caller could read platform summaries';
  exception when insufficient_privilege then null;
  end;
end;
$$;

rollback;
