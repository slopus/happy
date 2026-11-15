#!/usr/bin/env bash
set -euo pipefail
umask 077

PROJECT_DIR="${RAKAZO_DEPLOY_DIR:-/srv/rakazo}"
[[ "${PROJECT_DIR}" == /* ]] || { echo "RAKAZO_DEPLOY_DIR must be an absolute path" >&2; exit 1; }
COMPOSE_FILE="${PROJECT_DIR}/infra/compose/docker-compose.prod.yml"
ENV_FILE="${PROJECT_DIR}/.env"
BACKUP_ROOT="/var/backups/rakazo"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SNAPSHOT_DIR="${BACKUP_ROOT}/${STAMP}"
# Verified snapshots kept on this host.
KEEP="${RAKAZO_BACKUP_KEEP:-3}"
[[ "${KEEP}" =~ ^[1-9][0-9]*$ ]] || { echo "RAKAZO_BACKUP_KEEP must be a positive whole number" >&2; exit 1; }
OFFSITE="${RAKAZO_BACKUP_OFFSITE_REMOTE:-}"
# Off-site snapshots to keep; 0 leaves pruning to the destination's own lifecycle rules.
OFFSITE_KEEP="${RAKAZO_BACKUP_OFFSITE_KEEP:-14}"
[[ "${OFFSITE_KEEP}" =~ ^(0|[1-9][0-9]*)$ ]] || { echo "RAKAZO_BACKUP_OFFSITE_KEEP must be a whole number" >&2; exit 1; }

MIN_FREE_GB="${RAKAZO_BACKUP_MIN_FREE_GB:-5}"
MAX_GB="${RAKAZO_BACKUP_MAX_GB:-50}"
for value in "${MIN_FREE_GB}" "${MAX_GB}"; do
  [[ "${value}" =~ ^[1-9][0-9]*$ ]] || { echo "Backup space limits must be positive whole GiB" >&2; exit 1; }
done

# Encrypt every artifact to public age recipients. The private key never lives on this host,
# and plaintext is streamed straight into age, so it never touches disk.
age_args=()
read -r -a recipients <<<"${RAKAZO_BACKUP_AGE_RECIPIENTS:-}"
for recipient in "${recipients[@]}"; do age_args+=(-r "${recipient}"); done
RECIPIENTS_FILE="${RAKAZO_BACKUP_AGE_RECIPIENTS_FILE:-}"
if [[ -n "${RECIPIENTS_FILE}" ]]; then
  [[ -r "${RECIPIENTS_FILE}" && -s "${RECIPIENTS_FILE}" ]] || {
    echo "RAKAZO_BACKUP_AGE_RECIPIENTS_FILE is not a readable, non-empty file" >&2; exit 1;
  }
  age_args+=(-R "${RECIPIENTS_FILE}")
fi
suffix=""
if ((${#age_args[@]})); then
  command -v age >/dev/null || { echo "age is required to encrypt backups" >&2; exit 1; }
  age --encrypt "${age_args[@]}" </dev/null >/dev/null || { echo "age rejected the backup recipients" >&2; exit 1; }
  suffix=".age"
fi
# Written after the first encrypted snapshot, so losing the recipient config later fails loudly
# instead of quietly falling back to plaintext.
ENCRYPTED_MARKER="${BACKUP_ROOT}/.encrypted"
if [[ -z "${suffix}" ]]; then
  if [[ -e "${ENCRYPTED_MARKER}" && "${RAKAZO_BACKUP_ALLOW_PLAINTEXT:-0}" != 1 ]]; then
    echo "Backups on this host are encrypted; refusing to write plaintext. Set RAKAZO_BACKUP_AGE_RECIPIENTS, or RAKAZO_BACKUP_ALLOW_PLAINTEXT=1 to accept plaintext." >&2
    exit 1
  fi
  echo "WARNING: this backup is not encrypted. Set RAKAZO_BACKUP_AGE_RECIPIENTS to encrypt it." >&2
fi

reserve_kb=$((MIN_FREE_GB * 1024 * 1024))
budget_kb=$((MAX_GB * 1024 * 1024))
if [[ "${RAKAZO_BACKUP_REQUIRE_VOLUME:-0}" == 1 ]]; then
  mountpoint -q /var/backups || { echo "/var/backups must be a mounted backup volume" >&2; exit 1; }
  [[ "$(stat -c %d /var/backups)" != "$(stat -c %d /)" ]] || {
    echo "/var/backups must be on a separate filesystem" >&2; exit 1;
  }
fi

compose=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")

# Archive the appdata volume from the host, not through `compose exec api`: the cap-dropped
# api user cannot read the root-owned mode-600 bot homes, so its archive would miss the bot
# state a restore needs.
#
# Ask the running container where /data is rather than rebuilding the volume name: `compose
# config` ignores an operator's `-p`/COMPOSE_PROJECT_NAME and would archive the wrong volume.
# Every api replica mounts the same volume, so ask the first one.
api="$("${compose[@]}" ps -q api)"
api="${api%%$'\n'*}"
[[ -n "${api}" ]] || { echo "the api service is not running; cannot locate /data" >&2; exit 1; }
appdata="$(docker inspect "${api}" \
  --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')"
[[ -n "${appdata}" ]] || { echo "the api container has no /data mount" >&2; exit 1; }

install -d -m 700 "${BACKUP_ROOT}"
# One backup at a time, so cleanup never removes a snapshot another run is still writing.
exec 8>"${BACKUP_ROOT}/.lock"
flock -n 8 || { echo "Another Rakazo backup is running" >&2; exit 1; }
# Newest first; stamps sort by time. Only stamp-named directories are ever listed or removed.
snapshots() {
  find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended \
    -regex '.*/[0-9]{8}T[0-9]{6}Z' -print | sort -r
}

# Remove abandoned partial snapshots and excess history BEFORE checking free space.
# Always preserve the newest verified snapshot, even when the budget cannot be met.
verified_dirs=()
while read -r dir; do
  if [[ -f "${dir}/SHA256SUMS" ]]; then
    verified_dirs+=("${dir}")
  else
    rm -rf -- "${dir}"
  fi
done < <(snapshots)
while ((${#verified_dirs[@]} > KEEP)); do
  index=$((${#verified_dirs[@]} - 1))
  rm -rf -- "${verified_dirs[index]}"
  unset 'verified_dirs[index]'
done

# Scale only the previous appdata archive by appdata source growth. Older snapshots without
# size metadata use the uncompressed source as a conservative first-run estimate.
# The per-output limit below still bounds actual writes when compressibility changes.
last="${verified_dirs[0]:-}"
source_kb="$(du -sk "${appdata}" | awk '{ print $1 }')"
need_kb="${source_kb}"
if [[ -n "${last}" ]]; then
  last_kb="$(du -sk "${last}" | awk '{ print $1 }')"
  last_source=""
  [[ ! -f "${last}/SOURCE_SIZE_KB" ]] || last_source="$(cat "${last}/SOURCE_SIZE_KB")"
  last_archive="${last}/appdata.tgz"
  last_dump="${last}/rakazo.dump"
  [[ -f "${last_archive}" ]] || last_archive+=".age"
  [[ -f "${last_dump}" ]] || last_dump+=".age"
  if [[ "${last_source}" =~ ^[1-9][0-9]*$ && -f "${last_archive}" && -f "${last_dump}" ]]; then
    archive_kb="$(du -sk "${last_archive}" | awk '{ print $1 }')"
    dump_kb="$(du -sk "${last_dump}" | awk '{ print $1 }')"
    need_kb="$(awk -v archive="${archive_kb}" -v dump="${dump_kb}" -v current="${source_kb}" -v previous="${last_source}" \
      'BEGIN { printf "%.0f\n", dump + archive * current / previous }')"
  fi
  ((last_kb <= need_kb)) || need_kb="${last_kb}"
fi
need_kb=$((need_kb + need_kb / 4 + 1024 * 1024))
space() {
  free_kb="$(df -Pk "${BACKUP_ROOT}" | awk 'NR == 2 { print $4 }')"
  used_kb="$(du -sk "${BACKUP_ROOT}" | awk '{ print $1 }')"
}
space
while ((free_kb < need_kb + reserve_kb || used_kb + need_kb > budget_kb)) && ((${#verified_dirs[@]} > 1)); do
  index=$((${#verified_dirs[@]} - 1))
  rm -rf -- "${verified_dirs[index]}"
  unset 'verified_dirs[index]'
  space
done
if ((free_kb < need_kb + reserve_kb || used_kb + need_kb > budget_kb)); then
  echo "Only $((free_kb / 1024))MB free in ${BACKUP_ROOT}; this backup needs about $((need_kb / 1024))MB plus ${MIN_FREE_GB}GiB reserve, within a ${MAX_GB}GiB backup budget." >&2
  echo "Keeping the latest verified snapshot; increase backup capacity or reduce the source data." >&2
  exit 1
fi

mkdir -m 700 -- "${SNAPSHOT_DIR}"
# Never leave a partial snapshot behind: it uses space and looks like a backup.
verified=0
trap '[[ "${verified}" == 1 ]] || rm -rf -- "${SNAPSHOT_DIR}"' EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
printf '%s\n' "${source_kb}" >"${SNAPSHOT_DIR}/SOURCE_SIZE_KB"

# Cap each output at the smaller of the remaining budget and usable free space.
output_limit() {
  space
  limit_kb=$((free_kb - reserve_kb))
  remaining_kb=$((budget_kb - used_kb))
  ((limit_kb <= remaining_kb)) || limit_kb="${remaining_kb}"
  ((limit_kb > 0)) || { echo "Backup storage budget exhausted" >&2; return 1; }
}

# Write stdin to $1, sealed to the recipients when encryption is configured.
seal() {
  if [[ -n "${suffix}" ]]; then age --encrypt "${age_args[@]}" -o "$1"; else cat >"$1"; fi
}
dump_database() {
  "${compose[@]}" exec -T postgres sh -c \
    'pg_dump --format=custom --no-owner --no-privileges -U "$POSTGRES_USER" "$POSTGRES_DB"'
}
# Verifiers read the plaintext stream to its end, so verification needs no private key.
verify_database() {
  "${compose[@]}" exec -T postgres sh -c 'pg_restore --list >/dev/null && cat >/dev/null'
}
archive_appdata() { tar -czf - --numeric-owner -C "${appdata}" .; }
verify_appdata() { tar -tzf - >/dev/null && cat >/dev/null; }

# capture NAME PRODUCER VERIFIER: stream PRODUCER into SNAPSHOT_DIR/NAME, sealed when encrypting,
# while VERIFIER reads the same plaintext through a pipe. Returns the producer's status; a failed
# write or verification returns at least 2. Callers use `||`, so errors are checked explicitly.
capture() {
  local file="${SNAPSHOT_DIR}/$1${suffix}" pipe="${SNAPSHOT_DIR}/.verify" verifier status header=""
  output_limit || return 2
  mkfifo -m 600 -- "${pipe}" || return 2
  "$3" <"${pipe}" >/dev/null &
  verifier=$!
  (
    set +e
    ulimit -c 0
    ulimit -f "${limit_kb}"
    "$2" | tee -- "${pipe}" | seal "${file}"
    status=("${PIPESTATUS[@]}")
    ((status[1] == 0 && status[2] == 0)) || exit 2
    exit "${status[0]}"
  )
  status=$?
  wait "${verifier}" || { echo "$1 failed verification" >&2; ((status > 1)) || status=2; }
  rm -f -- "${pipe}"
  if [[ -n "${suffix}" ]] && ((status <= 1)); then
    IFS= read -r header <"${file}" || true
    [[ "${header}" == "age-encryption.org/v1" ]] || { echo "$1 is not an age file" >&2; status=2; }
  fi
  return "${status}"
}

rc=0
capture rakazo.dump dump_database verify_database || rc=$?
((rc == 0)) || { echo "database dump failed with exit ${rc}" >&2; exit "${rc}"; }

# Bots write while this runs. GNU tar exits 1 for "file changed as we read it",
# which is expected on a live system and still yields a usable archive; only a
# fatal error (2) fails the backup.
rc=0
capture appdata.tgz archive_appdata verify_appdata || rc=$?
if [[ "${rc}" -gt 1 ]]; then
  echo "appdata archive failed with exit ${rc}" >&2
  exit "${rc}"
fi

(cd "${SNAPSHOT_DIR}" && sha256sum "rakazo.dump${suffix}" "appdata.tgz${suffix}" SOURCE_SIZE_KB > SHA256SUMS.pending)
chmod 600 "${SNAPSHOT_DIR}"/*
sync -- "${SNAPSHOT_DIR}"/*
# Publish the completion marker only after every checksum is written.
mv "${SNAPSHOT_DIR}/SHA256SUMS.pending" "${SNAPSHOT_DIR}/SHA256SUMS"
sync -- "${SNAPSHOT_DIR}"

verified=1
[[ -z "${suffix}" ]] || : >"${ENCRYPTED_MARKER}"

# Keep the newest KEEP verified snapshots and drop the rest, including partial ones from failed
# runs. BACKUP_ROOT is intentionally fixed above so this can never reach a broad path.
kept=0
while read -r dir; do
  if [[ -f "${dir}/SHA256SUMS" ]] && ((kept < KEEP)); then
    kept=$((kept + 1))
  else
    rm -rf -- "${dir}"
  fi
done < <(snapshots)

echo "Verified Rakazo backup written to ${SNAPSHOT_DIR}"

# Optional off-site copy through any rclone remote (S3-compatible storage, SFTP, ...), configured
# with rclone's own settings. A failure here keeps the verified local snapshot but fails the run.
[[ -n "${OFFSITE}" ]] || exit 0
offsite_failed() { echo "Off-site copy failed: $1" >&2; exit 1; }
[[ -n "${suffix}" ]] || offsite_failed "off-site copies require RAKAZO_BACKUP_AGE_RECIPIENTS"
command -v rclone >/dev/null || offsite_failed "rclone is not installed"
# Accept "remote:", "remote:path" and "remote:path/".
remote="${OFFSITE%/}"
[[ "${remote}" == *: ]] || remote+="/"
# The checksum file goes only after the data checks out, so a remote snapshot with SHA256SUMS is
# complete and verified; retention counts nothing else.
rclone copy --exclude /SHA256SUMS -- "${SNAPSHOT_DIR}" "${remote}${STAMP}" || offsite_failed "upload"
rclone check --one-way --exclude /SHA256SUMS -- "${SNAPSHOT_DIR}" "${remote}${STAMP}" || offsite_failed "verification"
rclone copyto -- "${SNAPSHOT_DIR}/SHA256SUMS" "${remote}${STAMP}/SHA256SUMS" || offsite_failed "upload"
echo "Copied to ${remote}${STAMP}"

# Keep the newest OFFSITE_KEEP complete remote snapshots; remove other stamp-named directories.
((OFFSITE_KEEP > 0)) || exit 0
listing="$(rclone lsf -R --max-depth 2 -- "${remote}")" || offsite_failed "listing for retention"
stamp='^[0-9]{8}T[0-9]{6}Z/'
mapfile -t kept_remote < <(grep -E "${stamp}SHA256SUMS\$" <<<"${listing}" | cut -d/ -f1 | sort -r | head -n "${OFFSITE_KEEP}")
while read -r old; do
  [[ -n "${old}" && "${old}" != "${STAMP}" && " ${kept_remote[*]} " != *" ${old} "* ]] || continue
  rclone purge -- "${remote}${old}" || offsite_failed "pruning ${old}"
done < <(grep -oE "${stamp}" <<<"${listing}" | tr -d / | sort -u)
