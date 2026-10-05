-- Minimal stand-ins for the Supabase-managed schemas that OpenJury's
-- migrations reference, so the real migrations run unchanged in PGlite.
-- Demo only: there is no real authentication, storage or realtime server.

do $$
begin
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
exception when duplicate_object then null;
end;
$$;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key,
  email text,
  email_confirmed_at timestamptz default now(),
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create function auth.role() returns text
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;

create function auth.email() returns text
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.email', true), '') $$;

grant execute on all functions in schema auth to anon, authenticated, service_role;

create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

create table storage.buckets (
  id text primary key,
  name text not null,
  owner uuid,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text not null,
  owner uuid,
  owner_id text,
  metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;
grant all on storage.objects to authenticated, service_role;
grant select on storage.buckets to anon, authenticated, service_role;

create function storage.foldername(name text) returns text[]
language sql immutable
as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;

create function storage.filename(name text) returns text
language sql immutable
as $$ select (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)] $$;

create function storage.extension(name text) returns text
language sql immutable
as $$ select reverse(split_part(reverse(storage.filename(name)), '.', 1)) $$;

grant execute on all functions in schema storage to anon, authenticated, service_role;

create schema if not exists realtime;
grant usage on schema realtime to anon, authenticated, service_role;

create table realtime.messages (
  id bigserial primary key,
  topic text not null,
  extension text not null default 'broadcast',
  event text,
  payload jsonb,
  private boolean default true,
  inserted_at timestamptz not null default now()
);

create function realtime.topic() returns text
language sql stable
as $$ select nullif(current_setting('realtime.topic', true), '') $$;

-- Broadcasts become NOTIFY messages that the demo client relays to channels.
create function realtime.send(payload jsonb, event text, topic text, private boolean default true)
returns void
language plpgsql
as $$
begin
  perform pg_notify('demo_realtime', jsonb_build_object('topic', topic, 'event', event, 'payload', payload)::text);
end;
$$;

grant execute on all functions in schema realtime to anon, authenticated, service_role;

create publication supabase_realtime;
