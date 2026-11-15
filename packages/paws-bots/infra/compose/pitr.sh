#!/usr/bin/env bash
# Point-in-time recovery for the production Compose stack (docs/self-host-backups.md#point-in-time-recovery).
#
#   pitr.sh enable            give Postgres the replication login and settings, start the sidecar
#   pitr.sh disable           stop the sidecar and release the WAL Postgres keeps for it
#   pitr.sh restore TARGET VOLUME < identity
#                             recover the Postgres volume VOLUME to TARGET ("latest" or a time)
#   pitr.sh drill < identity  restore the latest point into a scratch volume, then remove it
#
# enable and disable run on the server, from the checkout. restore and drill run on any machine with
# Docker; the age identity comes on stdin and is only held in memory inside the restore container.
set -Eeuo pipefail
umask 077

HERE="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${RAKAZO_DEPLOY_DIR:-$(cd "${HERE}/../.." && pwd)}"
ENV_FILE="${PITR_ENV_FILE:-${PROJECT_DIR}/.env}"
COMPOSE_FILE="${PROJECT_DIR}/infra/compose/docker-compose.prod.yml"
ROLE=rakazo_pitr
HBA_LINE="host replication ${ROLE} all scram-sha-256"

die() { echo "$*" >&2; exit 1; }

# The last value .env gives NAME, without surrounding quotes.
setting() {
  local value
  value="$(sed -n "s/^$1=//p" "${ENV_FILE}" | tail -n 1)"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  printf '%s' "${value#\'}"
}

profile_enabled() { [[ ",$(setting COMPOSE_PROFILES)," == *,pitr,* ]]; }

compose() { docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"; }

# SQL as the database owner, over the container's local socket.
owner_sql() {
  # shellcheck disable=SC2016 # expanded inside the container
  compose exec -T postgres sh -c 'psql -X -q -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
}

# Adds or removes the replication line in pg_hba.conf, as the file's owner.
hba() {
  # shellcheck disable=SC2016 # expanded inside the container
  compose exec -T -u postgres postgres sh -c '
    file="$PGDATA/pg_hba.conf"
    if [ "$1" = add ]; then
      grep -qxF "$2" "$file" || printf "%s\n" "$2" >>"$file"
    elif grep -qxF "$2" "$file"; then
      grep -vxF "$2" "$file" >"$file.new" && cat "$file.new" >"$file" && rm -f "$file.new"
    fi' sh "$1" "${HBA_LINE}"
}

enable() {
  [[ -r "${ENV_FILE}" ]] || die "Cannot read ${ENV_FILE}"
  local password max_gb name
  password="$(setting PITR_DATABASE_PASSWORD)"
  [[ "${password}" =~ ^[A-Za-z0-9]{24,}$ ]] ||
    die "Set PITR_DATABASE_PASSWORD in .env to 24 or more letters and digits, for example: openssl rand -hex 24"
  for name in PITR_BUCKET PITR_ACCESS_KEY_ID PITR_SECRET_ACCESS_KEY PITR_AGE_RECIPIENTS; do
    [[ -n "$(setting "${name}")" ]] || die "Set ${name} in .env"
  done
  max_gb="$(setting PITR_MAX_WAL_GB)"
  max_gb="${max_gb:-4}"
  [[ "${max_gb}" =~ ^[1-9][0-9]*$ ]] || die "PITR_MAX_WAL_GB must be a positive whole number"
  # Deploys reconcile only the active profiles, so a sidecar outside them would never be updated.
  profile_enabled || die "Add pitr to COMPOSE_PROFILES in .env (comma-separated, for example COMPOSE_PROFILES=pitr)"

  compose up -d --wait postgres
  hba add
  # archive_timeout closes a WAL segment at least every minute while anything is written, which
  # bounds how much a lost server can take with it. Both settings apply on reload, no restart.
  owner_sql >/dev/null <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${ROLE}') THEN CREATE ROLE ${ROLE}; END IF;
END \$\$;
ALTER ROLE ${ROLE} WITH LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}';
ALTER SYSTEM SET archive_timeout = '60s';
ALTER SYSTEM SET max_slot_wal_keep_size = '${max_gb}GB';
SELECT pg_reload_conf();
SQL
  compose up -d --wait pitr
  echo "Point-in-time recovery is on. The first base backup is uploading; check it with:"
  echo "  docker compose --env-file .env -f infra/compose/docker-compose.prod.yml exec pitr rakazo-pitr health"
}

disable() {
  [[ -r "${ENV_FILE}" ]] || die "Cannot read ${ENV_FILE}"
  ! profile_enabled || die "Remove pitr from COMPOSE_PROFILES in .env first, so the next deploy does not restart it"
  compose --profile pitr rm --stop --force pitr
  owner_sql >/dev/null <<SQL
SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = '${ROLE}';
DROP ROLE IF EXISTS ${ROLE};
ALTER SYSTEM RESET archive_timeout;
ALTER SYSTEM RESET max_slot_wal_keep_size;
SELECT pg_reload_conf();
SQL
  hba remove
  echo "Point-in-time recovery is off. Uploaded backups stay in the bucket."
}

# Runs the agent's restore in a one-off container holding VOLUME at /var/lib/postgresql.
restore_into() {
  local target="$1" volume="$2" image name
  local -a env=()
  [[ -r "${ENV_FILE}" ]] || die "Cannot read ${ENV_FILE}"
  [[ -z "$(docker ps -q --filter "volume=${volume}")" ]] ||
    die "A running container uses ${volume}; stop it first (for production: compose stop api worker web pitr postgres)"
  for name in PITR_BUCKET PITR_ENDPOINT PITR_REGION PITR_ACCESS_KEY_ID PITR_SECRET_ACCESS_KEY PITR_PREFIX \
    PITR_PATH_STYLE PITR_SYSTEM_ID; do
    # Passed by name, so secrets stay out of the docker command line.
    export "${name}=$(setting "${name}")"
    env+=(-e "${name}")
  done
  local -a build=(--quiet --file "${HERE}/Dockerfile.pitr")
  [[ -z "$(setting POSTGRES_IMAGE)" ]] || build+=(--build-arg "POSTGRES_IMAGE=$(setting POSTGRES_IMAGE)")
  image="$(docker build "${build[@]}" "${HERE}")"
  # Root with just enough to move the old cluster aside; the agent drops to postgres for the rest.
  docker run --rm -i --user root --read-only --tmpfs /tmp --security-opt no-new-privileges:true \
    --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETUID --cap-add SETGID \
    "${env[@]}" -v "${volume}:/var/lib/postgresql" "${image}" restore "${target}"
}

restore() {
  local target="${1:?usage: pitr.sh restore latest|TIMESTAMP VOLUME < identity}"
  local volume="${2:?usage: pitr.sh restore latest|TIMESTAMP VOLUME < identity}"
  restore_into "${target}" "${volume}"
  echo "${volume} now holds the database as of ${target}. Earlier contents, if any, were moved aside in it."
}

drill() {
  DRILL_VOLUME="rakazo-pitr-drill-$$"
  docker volume create "${DRILL_VOLUME}" >/dev/null
  trap 'docker volume rm -f "${DRILL_VOLUME}" >/dev/null' EXIT
  restore_into latest "${DRILL_VOLUME}"
  echo "Drill passed: the latest backup restores and recovers"
}

case "${1:-}" in
  enable) enable ;;
  disable) disable ;;
  restore) restore "${2:-}" "${3:-}" ;;
  drill) drill ;;
  *) die "usage: pitr.sh enable|disable|restore TARGET VOLUME|drill" ;;
esac
