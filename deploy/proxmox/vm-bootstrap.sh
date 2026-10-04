#!/usr/bin/env bash
# Runs as root on a LAN VM (copied and started by vm.sh). Installs Docker, an
# HTTP-only Traefik ingress, Mailpit, and the openjury-<environment> runner.
# Reads a short-lived runner registration token on stdin; safe to rerun.
set -euo pipefail

repo="${1:?Usage: vm-bootstrap.sh <owner/repo> <dev|staging|production> < registration-token}"
environment="${2:?Usage: vm-bootstrap.sh <owner/repo> <dev|staging|production> < registration-token}"
[[ "$environment" =~ ^(dev|staging|production)$ ]] || { echo "Invalid environment" >&2; exit 1; }
runner_version=2.337.0
runner_sha256=70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613
runner_user=openjury-runner
runner_dir=/opt/actions-runner
traefik_image=traefik:v3.7.13
mailpit_image=axllent/mailpit:v1.31.4
token=""
read -r token || true

# CI records image IDs from the classic image store; containerd-store IDs differ,
# so previews could not start the tested image by ID.
daemon_json='{"features": {"containerd-snapshotter": false}}'
restart_docker=false
if [[ "$(cat /etc/docker/daemon.json 2>/dev/null)" != "$daemon_json" ]]; then
  install -d /etc/docker
  echo "$daemon_json" > /etc/docker/daemon.json
  restart_docker=true
fi

# Swap absorbs startup peaks of concurrent previews instead of OOM-killing them.
if [[ ! -f /swapfile ]]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
fi
swapon --show=NAME --noheadings | grep -qx /swapfile || swapon /swapfile
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/90-openjury-swap.conf
sysctl --quiet --load /etc/sysctl.d/90-openjury-swap.conf

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes ca-certificates curl git qemu-guest-agent docker.io docker-compose-v2
systemctl enable --now qemu-guest-agent docker
if [[ "$restart_docker" == true ]]; then
  systemctl restart docker
fi

if ! id "$runner_user" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$runner_user"
fi
# Docker access is root-equivalent inside this VM; keep the VM free of secrets.
usermod --append --groups docker "$runner_user"

docker network inspect openjury-proxy >/dev/null 2>&1 || docker network create openjury-proxy

# Dev serves Mailpit at http://mail.<domain>. Elsewhere magic links are login
# credentials, so Mailpit is reachable only through an SSH tunnel to the VM.
if [[ "$environment" == dev ]]; then
  # shellcheck disable=SC2016 # Backticks are Traefik rule syntax.
  mail_access='    labels:
      - traefik.enable=true
      - traefik.http.routers.openjury-mail.rule=HostRegexp(`^mail\..+`)
      - traefik.http.routers.openjury-mail.entrypoints=web
      - traefik.http.services.openjury-mail.loadbalancer.server.port=8025'
else
  mail_access='    ports:
      - "127.0.0.1:8025:8025"'
fi

install -d -m 0700 /opt/openjury-ingress
cat > /opt/openjury-ingress/compose.yml <<EOF
services:
  traefik:
    image: $traefik_image
    restart: unless-stopped
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop: [ALL]
    cap_add: [NET_BIND_SERVICE]
    command:
      - --api.dashboard=false
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --providers.docker.network=openjury-proxy
      - --entrypoints.web.address=:80
      - --ping=true
    ports:
      - "80:80"
    volumes:
      # A read-only socket mount does not restrict Docker API methods.
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks: [proxy]
    healthcheck:
      test: [CMD, traefik, healthcheck, --ping]
      interval: 10s
      timeout: 5s
      retries: 6

  # Catches magic-link emails from Auth unless the environment configures SMTP.
  mail:
    image: $mailpit_image
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    environment:
      MP_MAX_MESSAGES: 500
    networks:
      proxy:
        aliases: [openjury-mail]
$mail_access

networks:
  proxy:
    external: true
    name: openjury-proxy
EOF
docker compose --project-name openjury-ingress --file /opt/openjury-ingress/compose.yml \
  up --detach --wait --wait-timeout 120

# Registered runners update themselves; never unpack over an existing install.
if [[ ! -f "$runner_dir/config.sh" ]]; then
  archive="/var/cache/actions-runner-$runner_version.tar.gz"
  curl --fail --silent --show-error --location --output "$archive" \
    "https://github.com/actions/runner/releases/download/v$runner_version/actions-runner-linux-x64-$runner_version.tar.gz"
  echo "$runner_sha256  $archive" | sha256sum --check -
  install -d -o "$runner_user" -g "$runner_user" -m 0750 "$runner_dir"
  tar -xzf "$archive" -C "$runner_dir"
  chown -R "$runner_user:$runner_user" "$runner_dir"
  rm -f "$archive"
  "$runner_dir/bin/installdependencies.sh"
fi

cd "$runner_dir"
if [[ ! -f .runner ]]; then
  if [[ -z "$token" ]]; then
    echo "Runner is not registered and no registration token was given on stdin" >&2
    exit 1
  fi
  sudo -u "$runner_user" ./config.sh --unattended \
    --url "https://github.com/$repo" --token "$token" \
    --name "$(hostname)" --labels "openjury-$environment"
  ./svc.sh install "$runner_user"
fi
./svc.sh start || true
./svc.sh status
