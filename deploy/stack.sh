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
    IMAGE="${IMAGE:-openjury:unused}" APP_HOST="${APP_HOST:-unused.invalid}" \
      docker compose -f compose.yml down --volumes --remove-orphans
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
docker compose -f compose.yml up --detach --wait --wait-timeout 180 --remove-orphans
