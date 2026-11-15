#!/usr/bin/env bash
# upgrade-postgres.sh against real Docker: a Postgres 16 volume laid out like earlier releases,
# with the app's runtime login and row-level security, upgraded through the production Compose
# file's postgres service. Uses a throwaway Compose project and removes everything it creates.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
scratch="$(mktemp -d)"
# CI jobs share one Docker daemon and start with the same low PIDs, so the PID alone can
# match a run that is still going or one a cancelled job left behind; the scratch
# directory's random name keeps every run apart.
project="rakazo-pg-upgrade-test-$$-$(basename "${scratch}" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
export COMPOSE_PROJECT_NAME="${project}"
OLD_IMAGE="postgres:16@sha256:e17e86066e5ef83e0952a9347f5c792b7ece00972e2aa787a6986f471b3dd3d5"
fail() { echo "FAIL: $*" >&2; exit 1; }

mkdir -p "${scratch}/infra/compose"
cp "${root}/docker-compose.prod.yml" "${root}/upgrade-postgres.sh" "${scratch}/infra/compose/"
cat >"${scratch}/.env" <<'ENV'
POSTGRES_PASSWORD=owner-test-password
POSTGRES_APP_PASSWORD=app-test-password
SCREEN_PROXY_SECRET=test-screen-proxy-secret-0123456789abcdef
ENV
# The postgres service as releases before Postgres 18 defined it.
cat >"${scratch}/old.yml" <<YAML
services:
  postgres:
    image: ${OLD_IMAGE}
    environment:
      POSTGRES_USER: rakazo
      POSTGRES_PASSWORD: owner-test-password
      POSTGRES_DB: rakazo
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U rakazo -d rakazo"]
      interval: 1s
      retries: 60
volumes:
  pgdata:
YAML
old=(docker compose --env-file "${scratch}/.env" -f "${scratch}/old.yml")
new=(docker compose --env-file "${scratch}/.env" -f "${scratch}/infra/compose/docker-compose.prod.yml")
cleanup() {
  "${new[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  "${old[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "${scratch}"
}
trap cleanup EXIT

upgrade() { RAKAZO_DEPLOY_DIR="${scratch}" bash "${scratch}/infra/compose/upgrade-postgres.sh"; }
sql() { "$@" exec -T postgres psql -X -At -v ON_ERROR_STOP=1 -U rakazo -d rakazo; }
# Over the container's network address: loopback connections skip the password.
as_app() {
  # shellcheck disable=SC2016 # expanded inside the container
  "${new[@]}" exec -T -e PGPASSWORD=app-test-password postgres sh -c \
    'psql -X -At -v ON_ERROR_STOP=1 -h "$(hostname)" -U rakazo_app -d rakazo -c "$1"' sh "$1"
}

"${old[@]}" up -d --wait --quiet-pull postgres
# The shape the row-level security migration and provisionRuntimeRole leave behind.
sql "${old[@]}" >/dev/null <<'SQL'
CREATE ROLE rakazo_app LOGIN PASSWORD 'app-test-password' NOSUPERUSER NOBYPASSRLS;
GRANT CONNECT ON DATABASE rakazo TO rakazo_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rakazo_app;
CREATE TABLE threads (id serial PRIMARY KEY, "spaceId" text NOT NULL, title text);
INSERT INTO threads ("spaceId", title)
  SELECT CASE WHEN i % 2 = 0 THEN 'space-a' ELSE 'space-b' END, 'thread ' || i
  FROM generate_series(1, 500) AS i;
ALTER TABLE threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY threads_tenant ON threads
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY threads_system ON threads
  USING (current_setting('app.rls_bypass', true) = 'on');
GRANT USAGE ON SCHEMA public TO rakazo_app;
GRANT USAGE, SELECT ON SEQUENCE threads_id_seq TO rakazo_app;
SQL
"${old[@]}" stop postgres >/dev/null

# Without the upgrade, Postgres 18 refuses to start rather than creating an empty database.
"${new[@]}" up -d postgres >/dev/null 2>&1 || true
sleep 5
grep -q "there appears to be PostgreSQL data" <<<"$("${new[@]}" logs postgres 2>&1)" ||
  fail "Postgres 18 did not refuse the un-upgraded volume"
"${new[@]}" rm --stop --force postgres >/dev/null
# A Postgres 16 image under the new layout would open an empty database; it must not start.
POSTGRES_IMAGE="${OLD_IMAGE}" "${new[@]}" up -d postgres >/dev/null 2>&1 || true
sleep 3
grep -q "POSTGRES_IMAGE must be Postgres 18" <<<"$("${new[@]}" logs postgres 2>&1)" ||
  fail "a Postgres 16 image started with the Postgres 18 layout"
"${new[@]}" rm --stop --force postgres >/dev/null

# A runtime password that does not match fails the check before anything switches over, and
# fixing it and running again starts from scratch.
sed -i.bak 's/^POSTGRES_APP_PASSWORD=.*/POSTGRES_APP_PASSWORD=wrong-password/' "${scratch}/.env"
output="$(upgrade 2>&1)" && fail "upgrade passed with the wrong runtime password"
grep -q "Postgres 16 data is unchanged" <<<"${output}" || fail "unexpected failure: ${output}"
mv "${scratch}/.env.bak" "${scratch}/.env"
output="$(upgrade 2>&1)" || fail "upgrade failed: ${output}"
grep -q "^Upgraded to Postgres 18" <<<"${output}" || fail "unexpected output: ${output}"
"${new[@]}" exec -T postgres test ! -e /var/lib/postgresql/upgrade-stopped-services ||
  fail "the list of stopped services was left behind"

[[ "$(sql "${new[@]}" <<<"SHOW server_version_num")" -ge 180000 ]] || fail "not running Postgres 18"
[[ "$(sql "${new[@]}" <<<"SELECT count(*) FROM threads")" == 500 ]] || fail "rows were lost"
[[ "$(sql "${new[@]}" <<<"SELECT nextval('threads_id_seq')")" == 501 ]] || fail "the sequence was reset"
[[ "$(as_app "SELECT count(*) FROM threads")" == 0 ]] || fail "row-level security is not enforced"
[[ "$(as_app "SELECT set_config('app.space_id', 'space-a', false); SELECT count(*) FROM threads" | tail -n 1)" == 250 ]] ||
  fail "the runtime login lost its tenant rows"
as_app "INSERT INTO threads (\"spaceId\") VALUES ('space-a')" >/dev/null 2>&1 &&
  fail "a write outside the tenant passed row-level security"

output="$(upgrade 2>&1)" || fail "a second run failed: ${output}"
grep -q "already in place" <<<"${output}" || fail "a second run did not stop early: ${output}"

# Rollback: the previous release's Postgres 16 still opens the untouched original data.
"${new[@]}" stop postgres >/dev/null
"${old[@]}" up -d --wait postgres >/dev/null
[[ "$(sql "${old[@]}" <<<"SELECT count(*) FROM threads")" == 500 ]] || fail "rollback lost data"
[[ "$(sql "${old[@]}" <<<"SHOW server_version_num")" -lt 170000 ]] || fail "rollback is not Postgres 16"
echo "upgrade-postgres: ok"
