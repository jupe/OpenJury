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
preview=false
[[ "$COMPOSE_PROJECT_NAME" =~ ^openjury-pr-[1-9][0-9]*$ ]] && preview=true
# Plain HTTP is only for the LAN-only dev VM, whose ingress has no TLS entrypoint.
# APP_SCHEME is the public scheme; TLS_TERMINATION=upstream serves that HTTPS from
# a proxy in front of the VM, so Traefik only listens on plain HTTP.
traefik_tls=false
case "${APP_SCHEME:-https}" in
  https)
    case "${TLS_TERMINATION:-traefik}" in
      traefik) files=(-f compose.yml -f compose.tls.yml); traefik_tls=true ;;
      upstream) files=(-f compose.yml); export TRAEFIK_ENTRYPOINT=web ;;
      *) echo "TLS_TERMINATION must be traefik or upstream" >&2; exit 1 ;;
    esac
    ;;
  http)
    if [[ "$preview" != true ]]; then
      echo "Plain HTTP is only allowed for PR previews" >&2
      exit 1
    fi
    files=(-f compose.yml)
    export TRAEFIK_ENTRYPOINT=web
    ;;
  *) echo "APP_SCHEME must be http or https" >&2; exit 1 ;;
esac

# SUPABASE_MIGRATIONS bundles a self-hosted Supabase backend: disposable for PR
# previews, persistent (secrets kept on the host, data in volumes) otherwise.
if [[ -n "${SUPABASE_MIGRATIONS:-}" ]]; then
  if [[ ! -d "$SUPABASE_MIGRATIONS" ]]; then
    echo "SUPABASE_MIGRATIONS must be a directory" >&2
    exit 1
  fi
  b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
  jwt() {
    local header payload now
    now="$(date +%s)"
    header="$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)"
    # Keys are re-signed on every deploy; ten years keeps a quiet environment working.
    payload="$(printf '{"role":"%s","iss":"supabase","iat":%d,"exp":%d}' "$1" "$now" $((now + 315360000)) | b64url)"
    printf '%s.%s.%s' "$header" "$payload" \
      "$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | b64url)"
  }
  new_secrets() {
    printf 'JWT_SECRET=%s\nPOSTGRES_PASSWORD=%s\nREALTIME_SECRET_KEY_BASE=%s\n' \
      "$(openssl rand -hex 32)" "$(openssl rand -hex 24)" "$(openssl rand -hex 32)"
  }
  if [[ "$preview" == true ]]; then
    eval "$(new_secrets)"
  else
    # The database only takes its password when first initialized, so persistent
    # environments generate secrets once and refuse to reinvent them for old data.
    state="${OPENJURY_STATE_DIR:-$HOME/.local/state/openjury}/$COMPOSE_PROJECT_NAME/supabase.env"
    if [[ ! -f "$state" ]]; then
      if docker volume inspect "${COMPOSE_PROJECT_NAME}_db-data" >/dev/null 2>&1; then
        echo "$state is missing but the database volume exists; restore the file" >&2
        exit 1
      fi
      install -d -m 0700 "$(dirname "$state")"
      (umask 077 && new_secrets > "$state.tmp" && mv "$state.tmp" "$state")
    fi
    # shellcheck source=/dev/null
    source "$state"
  fi
  SUPABASE_URL="${APP_SCHEME:-https}://$APP_HOST"
  SUPABASE_ANON_KEY="$(jwt anon)"
  SUPABASE_SERVICE_KEY="$(jwt service_role)"
  # Password sign-in and the seeded account exist only on disposable previews,
  # where that account is also the platform admin unless one is configured.
  PASSWORD_SIGN_IN="$preview"
  if [[ "$preview" == true ]]; then
    PLATFORM_ADMIN_EMAILS="${PLATFORM_ADMIN_EMAILS:-${PREVIEW_ADMIN_EMAIL:-admin@openjury.test}}"
  fi
  export PLATFORM_ADMIN_EMAILS="${PLATFORM_ADMIN_EMAILS:-}"
  export JWT_SECRET POSTGRES_PASSWORD REALTIME_SECRET_KEY_BASE SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_KEY PASSWORD_SIGN_IN
  # Persistent environments give the app server their own service-role key for
  # competition-start emails; disposable previews never send real email.
  if [[ "$preview" != true ]]; then
    export SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-$SUPABASE_SERVICE_KEY}"
  fi
  files+=(-f compose.supabase.yml)
  if [[ "$traefik_tls" == true ]]; then
    files+=(-f compose.supabase.tls.yml)
  fi
  # Migrate before switching the app, so a new image never meets an old schema.
  docker compose "${files[@]}" up --detach --wait --wait-timeout 300 db auth rest realtime storage
  docker compose "${files[@]}" run --rm migrate
fi

# App-sent email links point at the public origin; previews get no default.
if [[ "$preview" != true ]]; then
  export APP_URL="${APP_URL:-${APP_SCHEME:-https}://$APP_HOST}"
fi
# Report which app email settings reach the container, by name only.
for name in SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_ADMIN_EMAIL APP_URL SUPABASE_SERVICE_ROLE_KEY; do
  if [[ -n "${!name:-}" ]]; then echo "App email setting $name: set"; else echo "App email setting $name: missing"; fi
done
docker compose "${files[@]}" up --detach --wait --wait-timeout 300 --remove-orphans
if [[ -n "${SUPABASE_MIGRATIONS:-}" && "$preview" == true ]]; then
  # This default is only for disposable previews; persistent environments never seed it.
  PREVIEW_ADMIN_PASSWORD="${PREVIEW_ADMIN_PASSWORD:-openjury-preview}" \
    PREVIEW_ADMIN_EMAIL="${PREVIEW_ADMIN_EMAIL:-admin@openjury.test}" python3 -c 'import json, os; print(json.dumps({
      "email": os.environ["PREVIEW_ADMIN_EMAIL"],
      "password": os.environ["PREVIEW_ADMIN_PASSWORD"],
      "email_confirm": True}))' |
    curl --fail --silent --show-error --output /dev/null \
      --retry 10 --retry-all-errors --retry-delay 2 \
        --header "apikey: $SUPABASE_SERVICE_KEY" --header "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
        --header "Content-Type: application/json" --data-binary @- "$SUPABASE_URL/auth/v1/admin/users"
fi
