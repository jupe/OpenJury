#!/usr/bin/env bash
# Run all SQL authorization tests against an isolated, real Supabase backend.
# Requires Docker Compose >= 2.24.4 and Node.js; no host ports are published.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

command -v node >/dev/null
docker compose version >/dev/null

# Never reuse deployment credentials or project names from the caller's shell.
COMPOSE_PROJECT_NAME="openjury-db-tests-$(node -e 'console.log(require("crypto").randomBytes(8).toString("hex"))')"
POSTGRES_PASSWORD="$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"
JWT_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
REALTIME_SECRET_KEY_BASE="$(node -e 'console.log(require("crypto").randomBytes(64).toString("hex"))')"
export COMPOSE_PROJECT_NAME POSTGRES_PASSWORD JWT_SECRET REALTIME_SECRET_KEY_BASE
export SUPABASE_URL=http://auth:9999
export SUPABASE_MIGRATIONS="$PWD/supabase/migrations"
export PLATFORM_ADMIN_EMAILS=""
export SMTP_HOST=localhost SMTP_PORT=1025
make_jwt() {
  node - "$1" <<'JS'
const crypto = require("crypto");
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const message = `${encode({alg: "HS256", typ: "JWT"})}.${encode({
  role: process.argv[2], iss: "supabase", iat: now, exp: now + 3600
})}`;
console.log(`${message}.${crypto.createHmac("sha256", process.env.JWT_SECRET).update(message).digest("base64url")}`);
JS
}
SUPABASE_ANON_KEY="$(make_jwt anon)"
SUPABASE_SERVICE_KEY="$(make_jwt service_role)"
export SUPABASE_ANON_KEY SUPABASE_SERVICE_KEY
compose=(docker compose --project-name "$COMPOSE_PROJECT_NAME" --file deploy/compose.database-tests.yml)
cleanup() {
  local status=$?
  trap - EXIT
  if (( status != 0 )); then
    "${compose[@]}" ps --all >&2 || true
    "${compose[@]}" logs --no-color --tail 60 2>&1 |
      sed -e "s/$POSTGRES_PASSWORD/[REDACTED]/g" \
          -e "s/$JWT_SECRET/[REDACTED]/g" \
          -e "s/$REALTIME_SECRET_KEY_BASE/[REDACTED]/g" \
          -e "s/$SUPABASE_ANON_KEY/[REDACTED]/g" \
          -e "s/$SUPABASE_SERVICE_KEY/[REDACTED]/g" >&2 || true
  fi
  "${compose[@]}" down --volumes --remove-orphans --timeout 10 || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"${compose[@]}" --profile migrate config --format json | node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const config = JSON.parse(input);
  const allowed = new Set(["db", "auth", "rest", "storage", "realtime", "migrate"]);
  for (const [name, service] of Object.entries(config.services)) {
    if (!allowed.has(name) || service.ports?.length ||
        service.network_mode || Object.keys(service.networks || {}).some(n => n !== "default") ||
        service.labels?.["traefik.enable"] === "true") {
      throw new Error("Unsafe database test service configuration: " + name);
    }
  }
  if (Object.values(config.networks).some(network => network.external) ||
      Object.values(config.volumes).some(volume => volume.external)) {
    throw new Error("Database tests must not use external networks or volumes");
  }
});
'
"${compose[@]}" up --detach --wait --wait-timeout 240 db auth rest storage realtime
# Uses the same readiness checks and migration runner as deployment.
"${compose[@]}" run --rm --no-deps migrate

shopt -s nullglob
tests=(supabase/tests/*.sql)
if (( ${#tests[@]} == 0 )); then
  echo "No SQL tests found" >&2
  exit 1
fi
failed=0
for test in "${tests[@]}"; do
  echo "Testing $test"
  if ! "${compose[@]}" exec --no-TTY --env PGPASSWORD="$POSTGRES_PASSWORD" db \
    psql --no-psqlrc --host localhost --username postgres --dbname postgres \
    --quiet --set ON_ERROR_STOP=1 < "$test"; then
    echo "FAILED: $test" >&2
    failed=$((failed + 1))
  fi
done
if (( failed > 0 )); then
  echo "$failed of ${#tests[@]} SQL test files failed." >&2
  exit 1
fi
echo "All ${#tests[@]} SQL test files passed."
