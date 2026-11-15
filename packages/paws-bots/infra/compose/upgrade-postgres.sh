#!/usr/bin/env bash
# One-time move of a Compose deployment's Postgres 16 data to Postgres 18.
#
#   sudo infra/compose/upgrade-postgres.sh [COMPOSE_FILE...]
#
# Compose files are relative to RAKAZO_DEPLOY_DIR (default /srv/rakazo) and default to the
# production file. The stack is stopped while it runs. It dumps every role and database from the
# 16 cluster, restores them into a new 18 cluster on the `postgres` volume, checks that roles,
# grants, row-level security and row counts match, and only then moves the new cluster to where
# Compose starts it. The 16 volume is only ever opened by a Postgres 16 server, so rolling back
# is starting the previous release. Running it again after it succeeded changes nothing.
set -Eeuo pipefail
umask 077

PROJECT_DIR="${RAKAZO_DEPLOY_DIR:-/srv/rakazo}"
[[ "${PROJECT_DIR}" == /* ]] || { echo "RAKAZO_DEPLOY_DIR must be an absolute path" >&2; exit 1; }
ENV_FILE="${PROJECT_DIR}/.env"
# The image the 16 cluster ran on. Override it only with a mirror of the same image.
OLD_IMAGE="${RAKAZO_POSTGRES_16_IMAGE:-postgres:16@sha256:e17e86066e5ef83e0952a9347f5c792b7ece00972e2aa787a6986f471b3dd3d5}"
LEGACY_DIR=/var/lib/postgresql/16/docker
STAGING_DIR=/var/lib/postgresql/18/upgrade
RUNTIME_LOGIN=rakazo_app
# Services this run stopped, kept in the volume so a retry after a failure still restarts them.
STOPPED_FILE=/var/lib/postgresql/upgrade-stopped-services

(($#)) || set -- infra/compose/docker-compose.prod.yml
compose=(docker compose --env-file "${ENV_FILE}")
for file in "$@"; do compose+=(-f "${PROJECT_DIR}/${file}"); done

# A shell in a throwaway container with the postgres service's own image, environment and volumes.
in_volume() { "${compose[@]}" run --rm --no-deps -T --entrypoint sh postgres -c "$1"; }

# One upgrade per host at a time. Production deploys also take their own lock, so neither starts
# while the other runs; only an existing deploy lock is used, as one created here would belong to
# root and lock the deploy user out.
if command -v flock >/dev/null; then
  exec 8>>"${TMPDIR:-/tmp}/rakazo-postgres-upgrade.lock"
  flock -n 8 || { echo "Another Postgres upgrade is running" >&2; exit 1; }
  if [[ -e "${PROJECT_DIR}/.deploy.lock" ]]; then
    exec 9>>"${PROJECT_DIR}/.deploy.lock"
    flock -n 9 || { echo "A deploy is running" >&2; exit 1; }
  fi
fi

# shellcheck disable=SC2016 # expanded inside the container
state="$(in_volume 'cat "$PGDATA/PG_VERSION" 2>/dev/null || echo -
cat '"${LEGACY_DIR}"'/PG_VERSION 2>/dev/null || echo -
echo "$POSTGRES_USER"
echo "$POSTGRES_DB"
du -sk '"${LEGACY_DIR}"' | cut -f1
df -Pk /var/lib/postgresql | awk "NR == 2 { print \$4 }"
if [ -e '"${STOPPED_FILE}"' ]; then echo "saved $(cat '"${STOPPED_FILE}"')"; else echo none; fi')"
{
  read -r current; read -r legacy; read -r user; read -r db; read -r used_kb; read -r free_kb
  read -r saved
} <<<"${state}"
[[ -n "${saved:-}" ]] || { echo "Could not inspect the Postgres volumes" >&2; exit 1; }
stopped="${saved#saved}"
restart_stopped() {
  # shellcheck disable=SC2086 # one service name per word
  [[ -z "${stopped// /}" ]] || "${compose[@]}" start ${stopped}
  in_volume "rm -f ${STOPPED_FILE}"
}
if [[ "${current}" != - ]]; then
  echo "Postgres ${current} data is already in place; nothing to upgrade."
  # A previous run switched over but failed before restarting the services it stopped.
  if [[ "${saved}" != none ]]; then
    "${compose[@]}" up -d --wait postgres
    restart_stopped
  fi
  exit 0
fi
if [[ "${legacy}" == - ]]; then
  echo "No Postgres 16 data found; nothing to upgrade."
  exit 0
fi
[[ "${legacy}" == 16 ]] || { echo "Expected Postgres 16 data, found ${legacy}" >&2; exit 1; }
if ((free_kb < used_kb + used_kb / 4 + 1048576)); then
  echo "Only $((free_kb / 1024))MB free; the upgrade needs about $((used_kb / 1024))MB plus 1GiB." >&2
  exit 1
fi
app_password="$(sed -n "s/^POSTGRES_APP_PASSWORD=//p" "${ENV_FILE}" | tail -n 1)"
app_password="${app_password#[\"\']}"
app_password="${app_password%[\"\']}"

# The Compose project keeps helpers of runs on a shared Docker daemon apart (their PIDs can match).
helper_suffix="${COMPOSE_PROJECT_NAME:+${COMPOSE_PROJECT_NAME}-}$$"
old="rakazo-postgres16-upgrade-${helper_suffix}"
new="rakazo-postgres18-upgrade-${helper_suffix}"
finish() {
  local status=$?
  docker rm --force "${old}" "${new}" >/dev/null 2>&1 || true
  if ((status != 0)); then
    echo "Upgrade failed. The Postgres 16 data is unchanged and the stack is stopped." >&2
    echo "Fix the error and run this again, or start the previous release to stay on Postgres 16." >&2
  fi
}
trap finish EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# The services to bring back afterwards; postgres itself is recreated on 18 below. A retry keeps
# the list from the first attempt, whose stop already left everything down.
if [[ "${saved}" == none ]]; then
  stopped="$("${compose[@]}" ps --services --status running | grep -vx postgres | tr '\n' ' ' || true)"
  in_volume "echo '${stopped}' >${STOPPED_FILE}"
fi
echo "Stopping the stack."
"${compose[@]}" stop

# A previous run that failed may have left a partial cluster here.
in_volume "rm -rf ${STAGING_DIR}"
# The new cluster starts from the service definition but outside its data directory, so the
# image's check for older data does not stop it. POSTGRES_DB=postgres leaves the app database
# for the dump to create, with its original owner and settings.
"${compose[@]}" run -d --no-deps --name "${new}" \
  -e PGDATA="${STAGING_DIR}" -e POSTGRES_DB=postgres postgres >/dev/null
legacy_volume="$(docker inspect "${new}" --format \
  "{{range .Mounts}}{{if eq .Destination \"${LEGACY_DIR}\"}}{{.Name}}{{end}}{{end}}")"
[[ -n "${legacy_volume}" ]] || { echo "The postgres service has no ${LEGACY_DIR} mount" >&2; exit 1; }
docker run -d --name "${old}" --network none \
  -v "${legacy_volume}:/var/lib/postgresql/data" "${OLD_IMAGE}" >/dev/null

# TCP only answers once the image's first-start initialization has finished.
wait_ready() {
  local _
  for _ in $(seq 120); do
    docker exec "$1" pg_isready -q -h 127.0.0.1 -U "${user}" 2>/dev/null && return 0
    sleep 1
  done
  docker logs --tail 20 "$1" >&2
  echo "Postgres in $1 did not become ready" >&2
  return 1
}
wait_ready "${old}"
wait_ready "${new}"

echo "Copying roles and databases to Postgres 18."
# The dump recreates every role, but the new cluster already has its bootstrap superuser, the
# same POSTGRES_USER; the ALTER ROLE after it still restores that role's password and attributes.
# Drop that one statement by exact text, with the name quoted the way pg_dumpall quotes it.
owner="$(docker exec "${old}" psql -X -At -U "${user}" -d postgres -c "SELECT quote_ident(current_user)")"
docker exec "${old}" pg_dumpall -U "${user}" \
  | CREATE_OWNER="CREATE ROLE ${owner};" awk '$0 != ENVIRON["CREATE_OWNER"]' \
  | docker exec -i "${new}" psql -X -q -v ON_ERROR_STOP=1 -U "${user}" -d postgres >/dev/null

# Everything the app depends on that a restore could lose: roles and their passwords (hashed
# again here so a mismatch never prints them), memberships, ownership, grants, row-level security
# and its policies, sequences, and exact row counts.
snapshot() {
  docker exec -i "$1" psql -X -At -v ON_ERROR_STOP=1 -U "${user}" -d "${db}" <<'SQL'
SELECT 'role', rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
  rolreplication, rolbypassrls, rolconnlimit, md5(coalesce(rolpassword, ''))
FROM pg_authid WHERE rolname !~ '^pg_' ORDER BY 2;
SELECT 'member', roleid::regrole::text, member::regrole::text, admin_option, inherit_option,
  set_option
FROM pg_auth_members
WHERE roleid::regrole::text !~ '^pg_' AND member::regrole::text !~ '^pg_' ORDER BY 2, 3;
SELECT 'database', datname, pg_get_userbyid(datdba), pg_encoding_to_char(encoding), datcollate,
  coalesce(datacl, acldefault('d', datdba))
FROM pg_database WHERE NOT datistemplate ORDER BY 2;
SELECT 'schema', nspname, pg_get_userbyid(nspowner), coalesce(nspacl, acldefault('n', nspowner))
FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' ORDER BY 2;
SELECT 'extension', extname FROM pg_extension ORDER BY 2;
SELECT 'relation', c.oid::regclass::text, c.relkind, pg_get_userbyid(c.relowner),
  -- Postgres 17 added the MAINTAIN privilege, which table owners now hold by default, so a
  -- 16 table whose grants were only the owner's comes back with the default (empty) list.
  (SELECT string_agg(grant_text, ',' ORDER BY grant_text) FROM (
    SELECT format('%s=%s%s/%s', coalesce(nullif(a.grantee, 0)::regrole::text, 'PUBLIC'),
      a.privilege_type, CASE WHEN a.is_grantable THEN '*' END, a.grantor::regrole) AS grant_text
    FROM aclexplode(coalesce(c.relacl, acldefault(
      CASE c.relkind WHEN 'S' THEN 's' ELSE 'r' END::"char", c.relowner))) a
    WHERE a.privilege_type <> 'MAINTAIN') grants),
  c.relrowsecurity, c.relforcerowsecurity,
  CASE WHEN c.relkind IN ('r', 'p') THEN (xpath('/row/n/text()', query_to_xml(
    format('SELECT count(*) AS n FROM %s', c.oid::regclass), false, true, '')))[1]::text END
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
ORDER BY 2;
SELECT 'policy', schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies ORDER BY 2, 3, 4;
SELECT 'sequence', schemaname, sequencename, last_value FROM pg_sequences ORDER BY 2, 3;
SELECT 'default acl', pg_get_userbyid(defaclrole), defaclnamespace::regnamespace::text,
  defaclobjtype, defaclacl
FROM pg_default_acl ORDER BY 2, 3, 4;
SELECT 'function', p.oid::regprocedure::text, pg_get_userbyid(p.proowner),
  coalesce(p.proacl, acldefault('f', p.proowner))
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
ORDER BY 2;
SQL
}
before="$(snapshot "${old}")"
after="$(snapshot "${new}")"
if [[ "${before}" != "${after}" ]]; then
  diff <(printf '%s\n' "${before}") <(printf '%s\n' "${after}") >&2 || true
  echo "The Postgres 18 copy differs from the original (16 above, 18 below); not switching." >&2
  exit 1
fi
tables="$(grep -c '^relation|[^|]*|[rp]|' <<<"${before}" || true)"

# The app's own login must still sign in with its password and stay subject to row-level
# security. Loopback connections are trusted without a password, so sign in on the container's
# network address instead.
login_exists="$(docker exec "${old}" psql -X -At -U "${user}" -d "${db}" \
  -c "SELECT count(*) FROM pg_roles WHERE rolname = '${RUNTIME_LOGIN}' AND rolcanlogin")"
if [[ "${login_exists}" == 1 ]]; then
  [[ -n "${app_password}" ]] || { echo "POSTGRES_APP_PASSWORD is missing from ${ENV_FILE}" >&2; exit 1; }
  # shellcheck disable=SC2016 # expanded inside the container
  bypass="$(PGPASSWORD="${app_password}" docker exec -e PGPASSWORD "${new}" sh -c \
    'psql -X -At -h "$(hostname)" -U "$1" -d "$2" -c "$3"' sh "${RUNTIME_LOGIN}" "${db}" \
    "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user")"
  [[ "${bypass}" == f ]] || { echo "${RUNTIME_LOGIN} bypasses row-level security on Postgres 18" >&2; exit 1; }
fi

docker stop --time 120 "${new}" "${old}" >/dev/null
docker rm "${new}" "${old}" >/dev/null
# Only now does Compose see an 18 cluster. mv -T refuses to merge into a non-empty directory.
in_volume "mv -T ${STAGING_DIR} \"\$PGDATA\""
"${compose[@]}" up -d --wait postgres
version="$("${compose[@]}" exec -T postgres psql -X -At -U "${user}" -d "${db}" \
  -c "SELECT split_part(current_setting('server_version'), ' ', 1)")"
restart_stopped
echo "Upgraded to Postgres ${version}: ${tables} tables, roles, grants and row-level security match."
echo "The Postgres 16 data is unchanged in volume ${legacy_volume}."
