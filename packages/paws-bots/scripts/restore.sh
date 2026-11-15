#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:?usage: restore.sh backups/<stamp>}"
compose=(docker compose -f "$ROOT/infra/compose/docker-compose.yml")
# Compose resolves its default env file relative to the compose file, not the
# repo root; point it at the root .env when one exists (vars may also come
# from the environment, so its absence is not an error).
if [[ -f "$ROOT/.env" ]]; then compose=(docker compose --env-file "$ROOT/.env" -f "$ROOT/infra/compose/docker-compose.yml"); fi
[[ -f "$SRC/rakazo.sql" ]] || { echo "missing rakazo.sql" >&2; exit 1; }
[[ ! -L "$ROOT/data" && ( ! -e "$ROOT/data" || -d "$ROOT/data" ) ]] || {
  echo "data must be a directory, not a symlink" >&2
  exit 1
}
STAGE=""
STOP_ON_FAILURE=0
cleanup() {
  local status=$?
  trap - EXIT
  trap '' HUP INT TERM
  if (( STOP_ON_FAILURE )); then
    "${compose[@]}" stop api worker supervisor || true
  fi
  if [[ -n "$STAGE" ]]; then rm -rf -- "$STAGE" || true; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ -e "$SRC/homes.tgz" || -L "$SRC/homes.tgz" ]]; then
  STAGE="$(mktemp -d "$ROOT/.restore.XXXXXX")"
  tar -tzf "$SRC/homes.tgz" > "$STAGE/members"
  if [[ -s "$STAGE/members" ]]; then
    while IFS= read -r member; do
      case "$member" in
        data|data/*) ;;
        *) echo "homes archive contains a path outside data" >&2; exit 1 ;;
      esac
      case "/$member/" in
        */../*) echo "homes archive contains a parent path" >&2; exit 1 ;;
      esac
    done < "$STAGE/members"
    tar -xzf "$SRC/homes.tgz" -C "$STAGE"
    [[ ! -L "$STAGE/data" && -d "$STAGE/data" ]] || {
      echo "homes archive must contain a data directory, not a symlink" >&2
      exit 1
    }
  fi
fi
STOP_ON_FAILURE=1
"${compose[@]}" stop api worker supervisor
"${compose[@]}" up -d postgres
until "${compose[@]}" exec -T postgres sh -c 'exec pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; do
  sleep 1
done
# Roles live outside the dump, and its grants name the runtime role. The API's
# start (its migration step) gives that role its login and grants afterwards.
"${compose[@]}" exec -T postgres sh -c 'exec psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' sh --set=ON_ERROR_STOP=on -c \
  "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN CREATE ROLE rakazo_app NOLOGIN; END IF; END \$\$"
# Stop on SQL errors and roll back the dump before restoring files or starting
# the application. -f is required for psql's single-transaction mode.
"${compose[@]}" exec -T postgres sh -c 'exec psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' sh \
  --set=ON_ERROR_STOP=on --single-transaction --file=- < "$SRC/rakazo.sql"
if [[ -n "$STAGE" && -d "$STAGE/data" ]]; then
  if [[ -e "$ROOT/data" ]]; then
    ROLLBACK="$(mktemp -d "$ROOT/data.rollback.XXXXXX")"
    mv "$ROOT/data" "$ROLLBACK/data"
    echo "Previous data preserved at $ROLLBACK/data"
  fi
  mv "$STAGE/data" "$ROOT/data"
fi
"${compose[@]}" up -d
STOP_ON_FAILURE=0
echo "Restore complete from $SRC"
