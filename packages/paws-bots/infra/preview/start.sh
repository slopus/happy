#!/usr/bin/env bash
# A pull request preview: Postgres and the whole app in one machine, every outside service
# emulated. The host's proxy stops the machine when nobody is visiting and starts it again on
# the next request, so this runs on every wake.
#
# The image comes from the pull request, so nothing here is trusted: each preview generates its
# own secrets on first boot and holds no credential for anything outside itself.
set -euo pipefail
umask 077

DATA=${PREVIEW_DATA_DIR:-/data}
PG_BIN=${PG_BIN:-/usr/lib/postgresql/18/bin}
PORT=${PORT:-8080}
HOST=${PREVIEW_HOST:-${FLY_APP_NAME:?Set PREVIEW_HOST or FLY_APP_NAME}.fly.dev}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OWNER_EMAIL=preview@example.com
OWNER_PASSWORD=rakazo-preview-demo
PGDATA="$DATA/postgres"
IMAGE_ID=$(cat "$ROOT/infra/preview/image-id" 2> /dev/null || true)
INITIALIZED_IMAGE="$PGDATA/.preview-image"

log() { printf '[preview] %s\n' "$*"; }
as_postgres() { gosu postgres "$@"; }

install -d -m 700 -o postgres -g postgres "$PGDATA"
install -d -m 750 -o node -g node "$DATA/app"
if [[ ! -s "$DATA/secrets.env" ]]; then
  {
    for name in BETTER_AUTH_SECRET ENCRYPTION_KEY SCREEN_PROXY_SECRET SANDBOX_SUPERVISOR_TOKEN \
      PG_OWNER_PASSWORD PG_APP_PASSWORD; do
      printf '%s=%s\n' "$name" "$(openssl rand -hex 32)"
    done
  } > "$DATA/secrets.env.tmp"
  mv "$DATA/secrets.env.tmp" "$DATA/secrets.env"
fi
set -a
# shellcheck source=/dev/null
. "$DATA/secrets.env"
set +a

init_database() {
  local pwfile
  pwfile=$(mktemp)
  printf '%s\n' "$PG_OWNER_PASSWORD" > "$pwfile"
  chown postgres "$pwfile"
  # The image sets no locale, so name one: initdb would otherwise pick SQL_ASCII, which rejects
  # characters outside ASCII that migrations and user text rely on.
  as_postgres "$PG_BIN/initdb" -D "$PGDATA" -U rakazo --auth=scram-sha-256 --pwfile="$pwfile" \
    --encoding=UTF8 --locale=C.UTF-8 > /dev/null
  rm -f "$pwfile"
}

start_database() {
  as_postgres "$PG_BIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/server.log" -w -s \
    -o "-c listen_addresses=127.0.0.1 -c port=5432 -c unix_socket_directories=''" start
  if ! PGPASSWORD=$PG_OWNER_PASSWORD "$PG_BIN/psql" -qtA -h 127.0.0.1 -U rakazo -d postgres \
    -c "SELECT 1 FROM pg_database WHERE datname = 'rakazo'" | grep -q 1; then
    rm -f "$INITIALIZED_IMAGE"
    PGPASSWORD=$PG_OWNER_PASSWORD "$PG_BIN/createdb" -h 127.0.0.1 -U rakazo rakazo
  fi
}

stop_database() {
  as_postgres "$PG_BIN/pg_ctl" -D "$PGDATA" -m fast -w -s stop || true
}

export NODE_ENV=production
export DATABASE_URL="postgres://rakazo_app:${PG_APP_PASSWORD}@127.0.0.1:5432/rakazo"
export DATA_DIR="$DATA/app"
export WEB_ORIGIN="https://$HOST" BETTER_AUTH_URL="https://$HOST" RAKAZO_HOST="$HOST"
export API_HOST=127.0.0.1 API_PORT=3100 API_URL=http://127.0.0.1:3100
export API_PROXY_TARGET=http://127.0.0.1:3100 WEB_PORT="$PORT"
export TRUSTED_PROXIES=127.0.0.1 CLIENT_IP_HEADER=fly-client-ip
export WAKEUP_DRIVER=graphile AGENT_RUNTIME=scripted SANDBOX_PROVIDER=fake
export CLOUD_AGENT_PROVIDER=emulator PAYMENT_WALLET_PROVIDER=emulator
export RAKAZO_LIVE_MODEL_CATALOG=off SIGNUPS_ENABLED=false CONTENT_ENCRYPTION=on

migrate() {
  DATABASE_MIGRATION_URL="postgres://rakazo:${PG_OWNER_PASSWORD}@127.0.0.1:5432/rakazo" \
    gosu node bash -c 'cd "$1/apps/api" && node --enable-source-maps dist/cli/migrate-database.js' \
    _ "$ROOT"
}

demo_account_exists() {
  PGPASSWORD=$PG_OWNER_PASSWORD "$PG_BIN/psql" -qtA -v ON_ERROR_STOP=1 \
    -v owner_email="$OWNER_EMAIL" -h 127.0.0.1 -U rakazo -d rakazo <<'SQL' | grep -qx t
SELECT EXISTS (SELECT 1 FROM "user" WHERE email = :'owner_email' AND "emailVerified");
SQL
}

shutdown() {
  kill $(jobs -pr) 2> /dev/null || true
  wait || true
  stop_database
}
trap shutdown EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# Answer at once while the database and API start, so the first visit after a wake sees a page.
gosu node node -e '
  require("node:http").createServer((_, res) => {
    res.writeHead(503, { "content-type": "text/html", "retry-after": "3" });
    res.end("<meta http-equiv=refresh content=3><title>Starting</title><p>Starting…</p>");
  }).listen(Number(process.argv[1]), "0.0.0.0");
' "$PORT" &
waiting=$!

[[ -f "$PGDATA/PG_VERSION" ]] || init_database
start_database
setup_required=
if [[ -z $IMAGE_ID || $(cat "$INITIALIZED_IMAGE" 2> /dev/null || true) != "$IMAGE_ID" ]]; then
  rm -f "$INITIALIZED_IMAGE"
  if ! migrate; then
    # A rewritten branch can leave migrations that no longer apply; a preview's data is disposable.
    log "Migrations failed; starting over with an empty database"
    stop_database
    find "$PGDATA" -mindepth 1 -delete
    find "$DATA/app" -mindepth 1 -delete
    init_database
    start_database
    migrate
  fi
  setup_required=1
fi
if [[ -n $setup_required ]] || ! demo_account_exists; then
  rm -f "$INITIALIZED_IMAGE"
  OWNER_EMAIL=$OWNER_EMAIL OWNER_PASSWORD=$OWNER_PASSWORD \
    gosu node bash -c 'cd "$1/apps/api" && node dist/cli/bootstrap-owner.js' _ "$ROOT"
  if [[ -n $IMAGE_ID ]]; then
    printf '%s\n' "$IMAGE_ID" > "$INITIALIZED_IMAGE.tmp"
    mv "$INITIALIZED_IMAGE.tmp" "$INITIALIZED_IMAGE"
  fi
fi

gosu node bash -c 'cd "$1/apps/api" && exec node --enable-source-maps dist/index.js' _ "$ROOT" &
gosu node bash -c 'cd "$1/apps/worker" && exec node --enable-source-maps dist/index.js' _ "$ROOT" &
ready=
for _ in $(seq 1 120); do
  curl -sf -o /dev/null --max-time 2 http://127.0.0.1:3100/ready && { ready=1; break; }
  sleep 1
done
# Exit rather than serve a page whose API never came up; the host restarts the machine.
[[ -n $ready ]] || { log "The API did not become ready"; exit 1; }
kill "$waiting"
wait "$waiting" 2> /dev/null || true
(
  cd "$ROOT/apps/web"
  exec env -u DATABASE_URL -u ENCRYPTION_KEY -u BETTER_AUTH_SECRET -u PG_OWNER_PASSWORD \
    -u PG_APP_PASSWORD gosu node node_modules/.bin/vite preview --host 0.0.0.0 --port "$PORT" \
    --strictPort
) &
log "Ready at https://$HOST"
wait -n
exit 1
