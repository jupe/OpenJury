#!/usr/bin/env bash
# Applies the PR's own migrations to its disposable preview database, once the
# Auth, Storage, and Realtime services have created the schemas they reference.
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

shopt -s nullglob
for migration in /migrations/*.sql; do
  echo "Applying ${migration##*/}"
  # Migrations manage their own transactions.
  psql --quiet --variable ON_ERROR_STOP=1 --file "$migration"
done
psql --quiet --command "notify pgrst, 'reload schema'"
