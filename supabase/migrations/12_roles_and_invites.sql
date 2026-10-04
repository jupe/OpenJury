begin;

-- Platform administrators come from deployment configuration: migrate.sh
-- replaces this list from PLATFORM_ADMIN_EMAILS on every deploy.
create table public.platform_admins (
  email text primary key
    check (email = lower(btrim(email)) and email ~ '^[^@[:space:]]+@[^@[:space:]]+$')
);
alter table public.platform_admins enable row level security;
revoke all on public.platform_admins from public, anon, authenticated;

-- Pending memberships: shareable links, and invitations addressed to an email
-- that are claimed when the owner of that confirmed address signs in.
create table public.group_invites (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  token text not null unique
    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index group_invites_group_id_idx on public.group_invites (group_id);

create table public.group_email_invites (
  group_id uuid not null references public.groups(id) on delete cascade,
  email text not null
    check (email = lower(btrim(email)) and email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (group_id, email)
);
create index group_email_invites_email_idx on public.group_email_invites (email);

-- How each member takes part in a competition: participants submit an entry,
-- the audience votes. Nobody does both.
create table public.competition_participants (
  competition_id uuid not null references public.competitions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('participant', 'audience')),
  joined_at timestamptz not null default now(),
  primary key (competition_id, user_id)
);
create index competition_participants_user_id_idx on public.competition_participants (user_id);

alter table public.group_invites enable row level security;
alter table public.group_email_invites enable row level security;
alter table public.competition_participants enable row level security;
revoke all on public.group_invites, public.group_email_invites, public.competition_participants
  from public, anon, authenticated;
grant select on public.competition_participants to authenticated;

create policy "Members read their own competition roles"
on public.competition_participants for select to authenticated
using (user_id = (select auth.uid()));

-- Existing competitions predate roles: entry creators become participants and
-- remaining voters the audience.
insert into public.competition_participants (competition_id, user_id, role)
select distinct entry.competition_id, entry.creator_id, 'participant'
from public.entries as entry
on conflict do nothing;
insert into public.competition_participants (competition_id, user_id, role)
select distinct entry.competition_id, vote.voter_id, 'audience'
from public.votes as vote
join public.entries as entry on entry.id = vote.entry_id
on conflict do nothing;

create function public.my_confirmed_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(account.email)
  from auth.users as account
  where account.id = auth.uid()
    and account.email_confirmed_at is not null;
$$;

create function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.platform_admins as platform_admin
    where platform_admin.email = public.my_confirmed_email()
  );
$$;

create function public.is_group_admin(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.group_members as membership
    where membership.group_id = p_group_id
      and membership.user_id = auth.uid()
      and membership.role = 'admin'
  );
$$;

create function public.require_group_admin(p_group_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_group_admin(p_group_id) then
    raise exception 'Group administrator access required' using errcode = '42501';
  end if;
end;
$$;

-- Platform administration: see every group, and take over any of them by
-- becoming one of its admins, which the existing admin checks then honor.
create function public.get_platform_groups()
returns table (id uuid, name text, member_count integer, admin_count integer, my_role text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Platform administrator access required' using errcode = '42501';
  end if;
  return query
    select target_group.id, target_group.name,
      (select count(*)::integer from public.group_members as membership
        where membership.group_id = target_group.id),
      (select count(*)::integer from public.group_members as membership
        where membership.group_id = target_group.id and membership.role = 'admin'),
      (select membership.role from public.group_members as membership
        where membership.group_id = target_group.id and membership.user_id = auth.uid())
    from public.groups as target_group
    order by lower(target_group.name), target_group.id;
end;
$$;

create function public.platform_admin_join_group(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Platform administrator access required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.groups where id = p_group_id) then
    raise exception 'Group not found' using errcode = '22023';
  end if;
  insert into public.group_members (group_id, user_id, role)
  values (p_group_id, auth.uid(), 'admin')
  on conflict (group_id, user_id) do update set role = 'admin';
end;
$$;

-- Group membership administration.
create function public.get_group_members(p_group_id uuid)
returns table (user_id uuid, email text, role text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_group_admin(p_group_id);
  return query
    select membership.user_id, account.email::text, membership.role
    from public.group_members as membership
    join auth.users as account on account.id = membership.user_id
    where membership.group_id = p_group_id
    order by membership.role, lower(account.email);
end;
$$;

create function public.set_group_member_role(p_group_id uuid, p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_group_admin(p_group_id);
  if p_role is null or p_role not in ('admin', 'member') then
    raise exception 'Role must be admin or member' using errcode = '22023';
  end if;
  -- Serialize admin changes so two admins cannot demote each other at once.
  perform 1 from public.groups where id = p_group_id for update;
  if p_role = 'member' and not exists (
    select 1 from public.group_members as membership
    where membership.group_id = p_group_id
      and membership.role = 'admin'
      and membership.user_id <> p_user_id
  ) then
    raise exception 'A group needs at least one admin' using errcode = '55000';
  end if;
  update public.group_members
    set role = p_role
    where group_id = p_group_id and user_id = p_user_id;
  if not found then
    raise exception 'Member not found' using errcode = '22023';
  end if;
end;
$$;

create function public.remove_group_member(p_group_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_group_admin(p_group_id);
  perform 1 from public.groups where id = p_group_id for update;
  if not exists (
    select 1 from public.group_members as membership
    where membership.group_id = p_group_id
      and membership.role = 'admin'
      and membership.user_id <> p_user_id
  ) then
    raise exception 'A group needs at least one admin' using errcode = '55000';
  end if;
  delete from public.group_members
    where group_id = p_group_id and user_id = p_user_id;
  if not found then
    raise exception 'Member not found' using errcode = '22023';
  end if;
end;
$$;

-- Invitations by email never reveal whether an account exists: they always
-- wait until the address owner signs in and claims them.
create function public.invite_group_member_by_email(p_group_id uuid, p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_email text := lower(btrim(p_email));
begin
  perform public.require_group_admin(p_group_id);
  if normalized_email is null
     or normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+$'
     or char_length(normalized_email) > 320 then
    raise exception 'Enter a valid email address' using errcode = '22023';
  end if;
  insert into public.group_email_invites (group_id, email, invited_by)
  values (p_group_id, normalized_email, auth.uid())
  on conflict (group_id, email) do nothing;
end;
$$;

create function public.get_group_email_invites(p_group_id uuid)
returns table (email text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_group_admin(p_group_id);
  return query
    select invite.email, invite.created_at
    from public.group_email_invites as invite
    where invite.group_id = p_group_id
    order by invite.email;
end;
$$;

create function public.revoke_group_email_invite(p_group_id uuid, p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_group_admin(p_group_id);
  delete from public.group_email_invites
    where group_id = p_group_id and email = lower(btrim(p_email));
end;
$$;

create function public.claim_group_invites()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed integer;
  confirmed_email text := public.my_confirmed_email();
begin
  if auth.uid() is null or confirmed_email is null then
    return 0;
  end if;
  with claimed_invites as (
    delete from public.group_email_invites as invite
    where invite.email = confirmed_email
    returning invite.group_id
  )
  insert into public.group_members (group_id, user_id, role)
  select claimed_invites.group_id, auth.uid(), 'member' from claimed_invites
  on conflict (group_id, user_id) do nothing;
  get diagnostics claimed = row_count;
  return claimed;
end;
$$;

create function public.create_group_invite(p_group_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_token text;
begin
  perform public.require_group_admin(p_group_id);
  insert into public.group_invites (group_id, created_by)
  values (p_group_id, auth.uid())
  returning token into new_token;
  return new_token;
end;
$$;

create function public.get_group_invite_links(p_group_id uuid)
returns table (id uuid, token text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_group_admin(p_group_id);
  return query
    select invite.id, invite.token, invite.created_at
    from public.group_invites as invite
    where invite.group_id = p_group_id and invite.revoked_at is null
    order by invite.created_at;
end;
$$;

create function public.revoke_group_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_group_id uuid;
begin
  select invite.group_id into target_group_id
    from public.group_invites as invite
    where invite.id = p_invite_id;
  perform public.require_group_admin(target_group_id);
  update public.group_invites
    set revoked_at = now()
    where id = p_invite_id and revoked_at is null;
end;
$$;

-- Holding the secret token is what authorizes seeing the group's name.
create function public.get_group_invite(p_token text)
returns table (group_id uuid, group_name text, is_member boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  return query
    select target_group.id, target_group.name, exists (
      select 1 from public.group_members as membership
      where membership.group_id = target_group.id and membership.user_id = auth.uid()
    )
    from public.group_invites as invite
    join public.groups as target_group on target_group.id = invite.group_id
    where invite.token = p_token and invite.revoked_at is null;
end;
$$;

create function public.accept_group_invite(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_group_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  select invite.group_id into target_group_id
    from public.group_invites as invite
    where invite.token = p_token and invite.revoked_at is null;
  if not found then
    raise exception 'This invite link is invalid or has been revoked' using errcode = '22023';
  end if;
  insert into public.group_members (group_id, user_id, role)
  values (target_group_id, auth.uid(), 'member')
  on conflict (group_id, user_id) do nothing;
  return target_group_id;
end;
$$;

-- Choosing a competition role. The audience may still join during voting;
-- switching roles stops once voting starts, and an entry keeps its creator a
-- participant.
create function public.join_competition(p_competition_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_group_id uuid;
  target_status text;
  existing_role text;
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('participant', 'audience') then
    raise exception 'Role must be participant or audience' using errcode = '22023';
  end if;

  select competition.group_id, competition.status
    into target_group_id, target_status
    from public.competitions as competition
    where competition.id = p_competition_id
    for update;
  if not found or not exists (
    select 1 from public.group_members as membership
    where membership.group_id = target_group_id and membership.user_id = actor
  ) then
    raise exception 'Competition not found or access denied' using errcode = '42501';
  end if;

  select participant.role into existing_role
    from public.competition_participants as participant
    where participant.competition_id = p_competition_id and participant.user_id = actor;
  if existing_role = p_role then
    return;
  end if;

  if existing_role is null then
    if target_status not in ('draft', 'submission')
       and not (p_role = 'audience' and target_status = 'voting') then
      raise exception 'This competition is no longer accepting %', p_role || 's'
        using errcode = '55000';
    end if;
  elsif target_status not in ('draft', 'submission') then
    raise exception 'Roles cannot change after voting starts' using errcode = '55000';
  elsif exists (
    select 1 from public.entries as entry
    where entry.competition_id = p_competition_id and entry.creator_id = actor
  ) then
    raise exception 'You already submitted an entry, so you stay a participant'
      using errcode = '55000';
  end if;

  insert into public.competition_participants (competition_id, user_id, role)
  values (p_competition_id, actor, p_role)
  on conflict (competition_id, user_id) do update set role = excluded.role, joined_at = now();
end;
$$;

create function public.get_competition_participants(p_competition_id uuid)
returns table (user_id uuid, email text, role text, has_entry boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_group_id uuid;
begin
  select competition.group_id into target_group_id
    from public.competitions as competition
    where competition.id = p_competition_id;
  if auth.uid() is null or not public.is_group_admin(target_group_id) then
    raise exception 'Competition administrator access required' using errcode = '42501';
  end if;
  return query
    select participant.user_id, account.email::text, participant.role, exists (
      select 1 from public.entries as entry
      where entry.competition_id = p_competition_id and entry.creator_id = participant.user_id
    )
    from public.competition_participants as participant
    join auth.users as account on account.id = participant.user_id
    where participant.competition_id = p_competition_id
    order by participant.role, lower(account.email);
end;
$$;

-- Only participants submit; only the audience votes. Each check is added to
-- the latest definition of the function, which is otherwise unchanged.
create or replace function public.save_submission(
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
  actor uuid := auth.uid();
  target_group_id uuid;
  target_status text;
  target_deadline timestamptz;
  saved_entry_id uuid;
  normalized_title text := btrim(p_title);
  media_count integer;
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select competition.group_id, competition.status, competition.submission_deadline
    into target_group_id, target_status, target_deadline
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

  if normalized_title is null
     or char_length(normalized_title) not between 1 and 100 then
    raise exception 'Entry title must contain 1 to 100 characters'
      using errcode = '22023';
  end if;
  if p_media_keys is null or cardinality(p_media_keys) > 5
     or array_position(p_media_keys, null) is not null then
    raise exception 'An entry may contain up to five valid media files'
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

  media_count := cardinality(p_media_keys);
  if exists (
    select 1
    from unnest(p_media_keys) as item(media_key)
    where item.media_key !~ (
      '^' || p_competition_id::text || '/' || saved_entry_id::text
      || '/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$'
    )
  ) or (
    select count(distinct item.media_key)
    from unnest(p_media_keys) as item(media_key)
  ) <> media_count then
    raise exception 'Media keys are invalid' using errcode = '22023';
  end if;

  if media_count > 0 and (
    select count(*)
    from storage.objects as object
    where object.bucket_id = 'competition-submissions'
      and object.name = any(p_media_keys)
      and object.owner_id = actor::text
      and object.metadata ->> 'mimetype' in ('image/jpeg', 'image/png', 'image/webp')
      and case when (object.metadata ->> 'size') ~ '^[0-9]{1,8}$'
        then (object.metadata ->> 'size')::bigint between 1 and 10485760
        else false end
      and case object.metadata ->> 'mimetype'
        when 'image/jpeg' then storage.filename(object.name) ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$'
        when 'image/png' then storage.filename(object.name) ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$'
        when 'image/webp' then storage.filename(object.name) ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$'
        else false end
  ) <> media_count then
    raise exception 'Media files are missing or invalid' using errcode = '22023';
  end if;

  update public.entries
    set title = normalized_title,
        media_keys = p_media_keys
    where id = saved_entry_id;

  return saved_entry_id;
end;
$$;

create or replace function public.save_ballot(
  p_competition_id uuid,
  p_entry_number bigint,
  p_scores jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_status text;
  target_deadline timestamptz;
  target_entry_id uuid;
  target_creator_id uuid;
  ballot_item jsonb;
  target_category_id uuid;
  target_max_score integer;
  ballot_score integer;
  score_count integer;
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select competition.status, competition.voting_deadline
    into target_status, target_deadline
    from public.competitions as competition
    where competition.id = p_competition_id
    for update;

  if not found or not exists (
    select 1
    from public.competitions as competition
    join public.group_members as membership
      on membership.group_id = competition.group_id
    where competition.id = p_competition_id
      and membership.user_id = actor
  ) then
    raise exception 'Competition not found or access denied'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.competition_participants as participant
    where participant.competition_id = p_competition_id
      and participant.user_id = actor
      and participant.role = 'audience'
  ) then
    raise exception 'Join the competition as audience to vote' using errcode = '42501';
  end if;

  if target_status <> 'voting'
     or (target_deadline is not null and clock_timestamp() >= target_deadline) then
    raise exception 'Voting is not open' using errcode = '55000';
  end if;

  select entry.id, entry.creator_id
    into target_entry_id, target_creator_id
    from public.entries as entry
    where entry.competition_id = p_competition_id
      and entry.random_number = p_entry_number
      and not entry.is_disqualified;

  if not found then
    raise exception 'Entry is not available for voting' using errcode = '22023';
  end if;
  if target_creator_id = actor then
    raise exception 'Self-voting is not permitted' using errcode = '22023';
  end if;
  if p_scores is null or jsonb_typeof(p_scores) is distinct from 'array' then
    raise exception 'A score is required for each category' using errcode = '22023';
  end if;

  score_count := jsonb_array_length(p_scores);
  if score_count = 0 or score_count <> (
    select count(*) from public.categories as category
    where category.competition_id = p_competition_id
  ) then
    raise exception 'A score is required for each category' using errcode = '22023';
  end if;

  for ballot_item in
    select item.value from jsonb_array_elements(p_scores) as item(value)
  loop
    if jsonb_typeof(ballot_item) is distinct from 'object'
       or ballot_item ->> 'category_id' is null
       or (ballot_item ->> 'category_id') !~
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(ballot_item -> 'score') is distinct from 'number'
       or (ballot_item ->> 'score') !~ '^[1-5]$' then
      raise exception 'Ballot category or score is invalid' using errcode = '22023';
    end if;

    target_category_id := (ballot_item ->> 'category_id')::uuid;
    ballot_score := (ballot_item ->> 'score')::integer;

    select category.max_score into target_max_score
      from public.categories as category
      where category.id = target_category_id
        and category.competition_id = p_competition_id;
    if not found or ballot_score > target_max_score then
      raise exception 'Ballot category or score is invalid' using errcode = '22023';
    end if;
  end loop;

  if (
    select count(distinct (item.value ->> 'category_id'))
    from jsonb_array_elements(p_scores) as item(value)
  ) <> score_count then
    raise exception 'Each category must have exactly one score' using errcode = '22023';
  end if;

  insert into public.votes (entry_id, voter_id, category_id, score)
  select target_entry_id, actor, (item.value ->> 'category_id')::uuid,
         (item.value ->> 'score')::integer
  from jsonb_array_elements(p_scores) as item(value)
  on conflict (entry_id, voter_id, category_id)
  do update set score = excluded.score;
end;
$$;

create or replace function public.get_blind_voting_entries(p_competition_id uuid)
returns table (entry_number bigint, media_keys text[])
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
     and participant.role = 'audience'
    where competition.id = p_competition_id
      and membership.user_id = actor
      and competition.status = 'voting'
      and (competition.voting_deadline is null
        or clock_timestamp() < competition.voting_deadline)
  ) then
    raise exception 'Blind voting is not available' using errcode = '42501';
  end if;

  return query
    select entry.random_number::bigint, entry.media_keys
    from public.entries as entry
    where entry.competition_id = p_competition_id
      and entry.creator_id <> actor
      and not entry.is_disqualified
    order by entry.random_number, entry.id;
end;
$$;

-- The single-score vote API predates ballots and skips the role check.
revoke all on function public.cast_vote(uuid, bigint, uuid, integer)
  from public, anon, authenticated;

-- Notify group pages when roles or invitations change.
create or replace function public.broadcast_group_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_group_id uuid;
  affected_competition_id uuid;
  affected_entry_id uuid;
  affected_user_id uuid;
begin
  if tg_table_name = 'groups' then
    affected_group_id := coalesce(new.id, old.id);
  elsif tg_table_name = 'group_members' then
    if tg_op = 'DELETE' then
      affected_group_id := old.group_id;
      affected_user_id := old.user_id;
    else
      affected_group_id := new.group_id;
      affected_user_id := new.user_id;
    end if;
  elsif tg_table_name in ('group_invites', 'group_email_invites') then
    affected_group_id := coalesce(new.group_id, old.group_id);
  elsif tg_table_name = 'competitions' then
    affected_group_id := coalesce(new.group_id, old.group_id);
  elsif tg_table_name in ('published_competition_results', 'categories', 'entries', 'competition_participants') then
    affected_competition_id := coalesce(new.competition_id, old.competition_id);
  elsif tg_table_name = 'votes' then
    affected_entry_id := coalesce(new.entry_id, old.entry_id);
    select entry.competition_id into affected_competition_id
    from public.entries as entry
    where entry.id = affected_entry_id;
  elsif tg_table_name = 'entry_disqualification_events' then
    affected_entry_id := coalesce(new.entry_id, old.entry_id);
    select entry.competition_id into affected_competition_id
    from public.entries as entry
    where entry.id = affected_entry_id;
  end if;

  if affected_competition_id is not null then
    select competition.group_id into affected_group_id
    from public.competitions as competition
    where competition.id = affected_competition_id;
  end if;

  if affected_group_id is not null then
    perform realtime.send(
      jsonb_build_object('version', 1),
      'data_changed',
      'group:' || affected_group_id::text,
      true
    );
  end if;

  if affected_user_id is not null then
    perform realtime.send(
      jsonb_build_object('version', 1),
      'membership_changed',
      'user:' || affected_user_id::text,
      true
    );
  end if;

  return null;
end;
$$;

create trigger group_invites_broadcast_change
after insert or update or delete on public.group_invites
for each row execute function public.broadcast_group_change();

create trigger group_email_invites_broadcast_change
after insert or update or delete on public.group_email_invites
for each row execute function public.broadcast_group_change();

create trigger competition_participants_broadcast_change
after insert or update or delete on public.competition_participants
for each row execute function public.broadcast_group_change();

do $$
declare
  signature text;
begin
  foreach signature in array array[
    'public.my_confirmed_email()',
    'public.is_platform_admin()',
    'public.is_group_admin(uuid)',
    'public.require_group_admin(uuid)',
    'public.get_platform_groups()',
    'public.platform_admin_join_group(uuid)',
    'public.get_group_members(uuid)',
    'public.set_group_member_role(uuid, uuid, text)',
    'public.remove_group_member(uuid, uuid)',
    'public.invite_group_member_by_email(uuid, text)',
    'public.get_group_email_invites(uuid)',
    'public.revoke_group_email_invite(uuid, text)',
    'public.claim_group_invites()',
    'public.create_group_invite(uuid)',
    'public.get_group_invite_links(uuid)',
    'public.revoke_group_invite(uuid)',
    'public.get_group_invite(text)',
    'public.accept_group_invite(text)',
    'public.join_competition(uuid, text)',
    'public.get_competition_participants(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', signature);
    execute format('grant execute on function %s to authenticated', signature);
  end loop;
end;
$$;

commit;
