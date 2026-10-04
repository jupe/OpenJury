#!/usr/bin/env bash
# Applies new migrations to the bundled database (a PR's own for previews, main's
# for staging and production), once the Auth, Storage, and Realtime services
# have created the schemas they reference.
set -euo pipefail

ready=f
for _ in $(seq 90); do
  ready="$(psql --tuples-only --no-align --command "select
    to_regclass('auth.users') is not null and
    to_regclass('storage.buckets') is not null and
    to_regclass('realtime.messages') is not null" 2>/dev/null || true)"
  [[ "$ready" == t ]] && break
  sleep 2
done
if [[ "$ready" != t ]]; then
  echo "Supabase services did not create the auth, storage, and realtime schemas" >&2
  exit 1
fi

# Hosted Supabase lets the postgres role manage Realtime policies; self-hosted
# images leave realtime.messages to supabase_realtime_admin alone.
PGUSER=supabase_admin psql --quiet --command "grant supabase_realtime_admin to postgres"

# Persistent environments keep their database, so apply each migration only once.
psql --quiet --variable ON_ERROR_STOP=1 --command "
  create schema if not exists openjury_meta;
  revoke all on schema openjury_meta from public;
  create table if not exists openjury_meta.applied_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )"

shopt -s nullglob
for migration in /migrations/*.sql; do
  name="${migration##*/}"
  applied="$(psql --tuples-only --no-align --variable ON_ERROR_STOP=1 --variable name="$name" \
    <<< "select count(*) from openjury_meta.applied_migrations where name = :'name'")"
  [[ "$applied" == 0 ]] || continue
  echo "Applying $name"
  # Migrations manage their own transactions, so the record follows separately.
  psql --quiet --variable ON_ERROR_STOP=1 --file "$migration"
  psql --quiet --variable ON_ERROR_STOP=1 --variable name="$name" \
    <<< "insert into openjury_meta.applied_migrations (name) values (:'name')"
done
psql --quiet --command "notify pgrst, 'reload schema'"
