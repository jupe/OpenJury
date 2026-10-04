#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
action="${1:?Usage: stack.sh deploy|destroy}"
: "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME is required}"
if [[ ! "$COMPOSE_PROJECT_NAME" =~ ^openjury-(pr-[1-9][0-9]*|staging|production)$ ]]; then
  echo "Invalid deployment project" >&2
  exit 1
fi

case "$action" in
  destroy)
    if [[ ! "$COMPOSE_PROJECT_NAME" =~ ^openjury-pr-[1-9][0-9]*$ ]]; then
      echo "Destructive operations are only allowed on PR previews" >&2
      exit 1
    fi
    # Teardown must also work when deployment configuration has been removed.
    container="$(docker ps --all --quiet \
      --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
      --filter "label=com.docker.compose.service=web")"
    old_image=""
    if [[ -n "$container" ]]; then
      old_image="$(docker inspect --format '{{.Image}}' "$container")"
    fi
    # Include the Supabase services so their database and storage volumes go too.
    IMAGE="${IMAGE:-openjury:unused}" APP_HOST="${APP_HOST:-unused.invalid}" \
      docker compose -f compose.yml -f compose.supabase.yml down --volumes --remove-orphans
    if [[ -n "$old_image" ]]; then
      docker image rm "$old_image" || echo "Image still referenced; leaving shared image in place."
    fi
    exit 0
    ;;
  deploy) ;;
  *) echo "Unknown deployment action" >&2; exit 1 ;;
esac

: "${IMAGE:?IMAGE is required}"
: "${APP_HOST:?APP_HOST is required}"
if [[ ! "$APP_HOST" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ || "$APP_HOST" != *.* ]]; then
  echo "APP_HOST must be a DNS hostname, without a scheme or path" >&2
  exit 1
fi
# Plain HTTP is only for the LAN-only dev VM, whose ingress has no TLS entrypoint.
case "${APP_SCHEME:-https}" in
  https) files=(-f compose.yml -f compose.tls.yml) ;;
  http)
    if [[ ! "$COMPOSE_PROJECT_NAME" =~ ^openjury-pr-[1-9][0-9]*$ ]]; then
      echo "Plain HTTP is only allowed for PR previews" >&2
      exit 1
    fi
    files=(-f compose.yml)
    export TRAEFIK_ENTRYPOINT=web
    ;;
  *) echo "APP_SCHEME must be http or https" >&2; exit 1 ;;
esac

# A PR preview with migrations gets its own disposable Supabase backend.
if [[ -n "${SUPABASE_MIGRATIONS:-}" ]]; then
  if [[ ! "$COMPOSE_PROJECT_NAME" =~ ^openjury-pr-[1-9][0-9]*$ || ! -d "$SUPABASE_MIGRATIONS" ]]; then
    echo "SUPABASE_MIGRATIONS must be a directory and is only allowed for PR previews" >&2
    exit 1
  fi
  b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
  jwt() {
    local header payload now
    now="$(date +%s)"
    header="$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)"
    payload="$(printf '{"role":"%s","iss":"supabase","iat":%d,"exp":%d}' "$1" "$now" $((now + 31536000)) | b64url)"
    printf '%s.%s.%s' "$header" "$payload" \
      "$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | b64url)"
  }
  JWT_SECRET="$(openssl rand -hex 32)"
  POSTGRES_PASSWORD="$(openssl rand -hex 24)"
  REALTIME_SECRET_KEY_BASE="$(openssl rand -hex 32)"
  SUPABASE_URL="${APP_SCHEME:-https}://$APP_HOST"
  SUPABASE_ANON_KEY="$(jwt anon)"
  SUPABASE_SERVICE_KEY="$(jwt service_role)"
  export JWT_SECRET POSTGRES_PASSWORD REALTIME_SECRET_KEY_BASE SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_KEY
  files+=(-f compose.supabase.yml)
  if [[ "${APP_SCHEME:-https}" == https ]]; then
    files+=(-f compose.supabase.tls.yml)
  fi
fi

docker compose "${files[@]}" up --detach --wait --wait-timeout 300 --remove-orphans
if [[ -n "${SUPABASE_MIGRATIONS:-}" ]]; then
  docker compose "${files[@]}" run --rm migrate
  # Optional fixed preview account, so sign-in needs no email round trip.
  if [[ -n "${PREVIEW_ADMIN_PASSWORD:-}" ]]; then
    PREVIEW_ADMIN_EMAIL="${PREVIEW_ADMIN_EMAIL:-admin@openjury.test}" python3 -c 'import json, os; print(json.dumps({
      "email": os.environ["PREVIEW_ADMIN_EMAIL"],
      "password": os.environ["PREVIEW_ADMIN_PASSWORD"],
      "email_confirm": True}))' |
      curl --fail --silent --show-error --output /dev/null \
        --retry 10 --retry-all-errors --retry-delay 2 \
        --header "apikey: $SUPABASE_SERVICE_KEY" --header "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
        --header "Content-Type: application/json" --data-binary @- "$SUPABASE_URL/auth/v1/admin/users"
  fi
fi
