#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="${1-$(date +%Y%m%d-%H%M%S)}"
case "$STAMP" in
  ""|.|..|*/*) echo "backup stamp must be a single nonempty path component" >&2; exit 1 ;;
esac
OUT="${ROOT}/backups/${STAMP}"
compose=(docker compose -f "$ROOT/infra/compose/docker-compose.yml")
# Compose resolves its default env file relative to the compose file, not the
# repo root; point it at the root .env when one exists (vars may also come
# from the environment, so its absence is not an error).
if [[ -f "$ROOT/.env" ]]; then compose=(docker compose --env-file "$ROOT/.env" -f "$ROOT/infra/compose/docker-compose.yml"); fi
[[ ! -L "$ROOT/backups" && ! -L "$OUT" ]] || { echo "backup directory must not be a symlink" >&2; exit 1; }
mkdir -p "$OUT"
chmod 700 "$ROOT/backups" "$OUT"
for artifact in "$OUT/rakazo.sql" "$OUT/homes.tgz"; do
  [[ ! -L "$artifact" ]] || { echo "backup artifact must not be a symlink" >&2; exit 1; }
  if [[ -e "$artifact" ]]; then
    [[ -f "$artifact" ]] || { echo "backup artifact is not a file" >&2; exit 1; }
    chmod 600 "$artifact"
  fi
done
"${compose[@]}" exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$OUT/rakazo.sql"
if [[ "${RAKAZO_BACKUP_SKIP_HOMES:-0}" == "1" ]] || [[ ! -e "$ROOT/data" && ! -L "$ROOT/data" ]]; then
  tar -czf "$OUT/homes.tgz" --files-from /dev/null
else
  [[ ! -L "$ROOT/data" && -d "$ROOT/data" ]] || { echo "data must be a directory, not a symlink" >&2; exit 1; }
  tar -czf "$OUT/homes.tgz" -C "$ROOT" data
fi
echo "Backup written to $OUT"
