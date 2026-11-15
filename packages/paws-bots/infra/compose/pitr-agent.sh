#!/usr/bin/env bash
# Point-in-time recovery for the Compose Postgres (docs/self-host-backups.md#point-in-time-recovery).
#
#   run                 stream WAL with pg_receivewal over a replication slot, upload each finished
#                       segment, and take a daily pg_basebackup; everything is age-encrypted to
#                       PITR_AGE_RECIPIENTS before it leaves this container
#   health              exit nonzero when archiving has stalled
#   restore TARGET      recover $PGDATA to TARGET ("latest" or a timestamp) from object storage;
#                       reads the age identity from stdin and keeps it in /tmp (a tmpfs)
#   fetch-wal FILE PATH the restore_command used by restore
#
# Postgres itself has no network egress: this container reaches it over the internal data network
# and object storage over its own.
set -Eeuo pipefail
umask 077

SLOT=rakazo_pitr
SPOOL=/var/lib/rakazo-pitr
# pg_receivewal's directory. Segments from an earlier cluster or timeline move to held/<system id>
# so pg_receivewal never resumes from them; they are still uploaded.
WAL_DIR="${SPOOL}/wal"
HELD_DIR="${SPOOL}/held"
STATE="${SPOOL}/state"
OUTBOX="${SPOOL}/outbox"
BASE_INTERVAL=$((24 * 3600))
BASE_RETRY=3600
# A segment waiting this long means uploads have stalled; archive_timeout closes one every minute.
UPLOAD_STALE=600
RESTORE_WAL=/var/lib/postgresql/pitr-restore-wal
IDENTITY=/tmp/pitr-identity
# Files pg_receivewal has finished: compressed segments and timeline histories (which it also gzips).
FINISHED='[0-9A-F]{24}\.gz|[0-9A-F]{8}\.history\.gz'

log() { printf '%s\n' "$*" >&2; }
die() { log "$*"; exit 1; }

# Pure helpers below take their inputs as arguments or stdin, so they are tested offline.

# wal_name TIMELINE LSN SEGMENT_BYTES: the WAL file holding LSN.
wal_name() {
  local hi="${2%/*}" lo="${2#*/}" per seg
  per=$((0x100000000 / $3))
  seg=$((((16#${hi} << 32) | 16#${lo}) / $3))
  printf '%08X%08X%08X\n' "$1" $((seg / per)) $((seg % per))
}

# plan_prune NOW RETAIN_DAYS < listing: what to delete so every moment of the last RETAIN_DAYS
# stays recoverable. Listing lines, oldest base first:
#   base STAMP START_WAL END_EPOCH TIMELINE | partial STAMP | wal FILE
# Keeps every base that finished inside the window plus the newest one before it, removes
# unfinished bases older than the newest finished one, and WAL older than the oldest kept base.
# Timeline history files are always kept.
plan_prune() {
  local cutoff=$(($1 - $2 * 86400)) kind a b c first=0 i oldest=""
  local -a stamps=() starts=() ends=() partials=() wals=()
  while read -r kind a b c _ || [[ -n "${kind}" ]]; do
    case "${kind}" in
      base) stamps+=("${a}") starts+=("${b}") ends+=("${c}") ;;
      partial) partials+=("${a}") ;;
      wal) wals+=("${a}") ;;
    esac
  done
  ((${#stamps[@]})) || return 0
  for i in "${!stamps[@]}"; do
    ((ends[i] >= cutoff)) || first="${i}"
  done
  for ((i = 0; i < first; i++)); do echo "purge base/${stamps[i]}"; done
  for a in "${partials[@]}"; do
    [[ "${a}" > "${stamps[-1]}" ]] || echo "purge base/${a}"
  done
  # A base on a later timeline can start below an older one, after a restore rewound the database.
  for ((i = first; i < ${#stamps[@]}; i++)); do
    [[ -n "${oldest}" && ! "${starts[i]:8:16}" < "${oldest}" ]] || oldest="${starts[i]:8:16}"
  done
  for a in "${wals[@]}"; do
    [[ "${a}" =~ ^[0-9A-F]{24}\. ]] || continue
    [[ ! "${a:8:16}" < "${oldest}" ]] || echo "delete wal/${a}"
  done
}

# plan_restore TARGET_EPOCH|latest < base lines: the newest base that finished before the target.
plan_restore() {
  local kind stamp start end timeline chosen=""
  while read -r kind stamp start end timeline _ || [[ -n "${kind}" ]]; do
    [[ "${kind}" == base ]] || continue
    if [[ "$1" == latest ]] || ((end < $1)); then chosen="${stamp} ${start} ${timeline}"; fi
  done
  [[ -n "${chosen}" ]] && echo "${chosen}"
}

storage_config() {
  : "${PITR_BUCKET:?Set PITR_BUCKET}"
  [[ "${PITR_BUCKET}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "PITR_BUCKET is not a valid bucket name"
  local prefix="${PITR_PREFIX:-}"
  prefix="${prefix#/}"
  prefix="${prefix%/}"
  [[ -z "${prefix}" || ("${prefix}" =~ ^[A-Za-z0-9._/-]+$ && "/${prefix}/" != */../* && "/${prefix}/" != *//*) ]] ||
    die "PITR_PREFIX may only hold letters, digits, '.', '_', '-' and '/'"
  case "${PITR_PATH_STYLE:-false}" in
    true | false) ;;
    *) die "PITR_PATH_STYLE must be true or false" ;;
  esac
  [[ -z "${PITR_ENDPOINT:-}" || "${PITR_ENDPOINT}" =~ ^https?:// ]] || die "PITR_ENDPOINT must be an http(s) URL"
  # rclone reads a remote named "pitr" from these; nothing is written to a config file.
  export RCLONE_CONFIG_PITR_TYPE=s3
  export RCLONE_CONFIG_PITR_PROVIDER="${PITR_ENDPOINT:+Other}"
  : "${RCLONE_CONFIG_PITR_PROVIDER:=AWS}"
  export RCLONE_CONFIG_PITR_ENV_AUTH=false
  export RCLONE_CONFIG_PITR_ACCESS_KEY_ID="${PITR_ACCESS_KEY_ID:?Set PITR_ACCESS_KEY_ID}"
  export RCLONE_CONFIG_PITR_SECRET_ACCESS_KEY="${PITR_SECRET_ACCESS_KEY:?Set PITR_SECRET_ACCESS_KEY}"
  export RCLONE_CONFIG_PITR_REGION="${PITR_REGION:-}"
  export RCLONE_CONFIG_PITR_ENDPOINT="${PITR_ENDPOINT:-}"
  export RCLONE_CONFIG_PITR_FORCE_PATH_STYLE="${PITR_PATH_STYLE:-false}"
  # The credentials need no bucket-level permissions.
  export RCLONE_CONFIG_PITR_NO_CHECK_BUCKET=true
  # Streamed base backups upload in parts of this size, up to 10,000 parts (about 150 GiB).
  export RCLONE_CONFIG_PITR_CHUNK_SIZE=16M
  export RCLONE_RETRIES=3 RCLONE_LOW_LEVEL_RETRIES=10 RCLONE_CONTIMEOUT=30s RCLONE_TIMEOUT=5m RCLONE_STATS=0
  REMOTE="pitr:${PITR_BUCKET}${prefix:+/${prefix}}"
}

archive_config() {
  storage_config
  RETAIN_DAYS="${PITR_RETAIN_DAYS:-7}"
  [[ "${RETAIN_DAYS}" =~ ^(0|[1-9][0-9]*)$ ]] || die "PITR_RETAIN_DAYS must be a whole number"
  local max_gb="${PITR_MAX_WAL_GB:-4}"
  [[ "${max_gb}" =~ ^[1-9][0-9]*$ ]] || die "PITR_MAX_WAL_GB must be a positive whole number"
  MAX_SPOOL_KB=$((max_gb * 1024 * 1024))
  local recipient
  AGE_ARGS=()
  read -r -a recipients <<<"${PITR_AGE_RECIPIENTS:-}"
  for recipient in "${recipients[@]}"; do AGE_ARGS+=(-r "${recipient}"); done
  ((${#AGE_ARGS[@]})) || die "Set PITR_AGE_RECIPIENTS to the public age keys backups are encrypted to"
  age --encrypt "${AGE_ARGS[@]}" </dev/null >/dev/null || die "age rejected PITR_AGE_RECIPIENTS"
  [[ -n "${PGPASSWORD:-}" ]] || die "Set PITR_DATABASE_PASSWORD"
}

# rclone exits 3 for a prefix that holds nothing yet.
lsf() {
  local rc=0
  rclone lsf "$@" || rc=$?
  ((rc == 0 || rc == 3))
}

sql() { psql -X -At -v ON_ERROR_STOP=1 -c "$1"; }

# "SYSTEM_ID TIMELINE" of the server.
identify() {
  local row
  row="$(psql -X -At -F ' ' -d replication=true -c IDENTIFY_SYSTEM)" || return 1
  awk '{ print $1, $2 }' <<<"${row}"
}

# base/ listing lines for plan_prune and plan_restore, oldest first.
list_bases() {
  local root="$1" files stamp meta start end timeline
  files="$(lsf -R --files-only "${root}/base")" || return 1
  for stamp in $(grep -oE '^[0-9]{8}T[0-9]{6}Z/' <<<"${files}" | tr -d / | sort -u); do
    if grep -qxF "${stamp}/COMPLETE" <<<"${files}"; then
      meta="$(rclone cat "${root}/base/${stamp}/COMPLETE")" || return 1
      start="$(sed -n 's/^start_wal=//p' <<<"${meta}")"
      end="$(sed -n 's/^end_time=//p' <<<"${meta}")"
      timeline="$(sed -n 's/^timeline=//p' <<<"${meta}")"
      # Bucket contents are untrusted: anything else would reach shell arithmetic.
      if [[ "${start}" =~ ^[0-9A-F]{24}$ && "${end}" =~ ^[0-9]{1,12}$ && "${timeline}" =~ ^[0-9]{1,10}$ ]]; then
        echo "base ${stamp} ${start} ${end} ${timeline}"
      else
        log "Ignoring base backup ${stamp}: its COMPLETE marker is malformed"
      fi
    else
      echo "partial ${stamp}"
    fi
  done
}

ready_files() {
  local pattern="${FINISHED}"
  [[ "${2:-}" != held ]] || pattern+='|[0-9A-F]{24}\.gz\.partial'
  find "$1" -maxdepth 1 -type f -regextype posix-extended -regex ".*/(${pattern})" -printf '%f\n' | sort
}

# Encrypt and upload every finished file in DIR to ROOT/wal, oldest first, then delete it here.
upload_dir() {
  local dir="$1" root="$2" kind="${3:-}" name
  local -a names
  while mapfile -t names < <(ready_files "${dir}" "${kind}" | head -n 32) && ((${#names[@]})); do
    rm -rf -- "${OUTBOX}"
    mkdir -p -- "${OUTBOX}"
    for name in "${names[@]}"; do
      age --encrypt "${AGE_ARGS[@]}" -o "${OUTBOX}/${name}.age" "${dir}/${name}" || return 1
    done
    enforce_limit
    if ! rclone copy --no-traverse "${OUTBOX}" "${root}/wal"; then
      log "WAL upload failed; retrying"
      return 1
    fi
    for name in "${names[@]}"; do rm -f -- "${dir}/${name}"; done
    date +%s >"${STATE}/last-upload"
  done
}

upload_ready() {
  local dir
  upload_dir "${WAL_DIR}" "${ROOT}" || return 1
  for dir in "${HELD_DIR}"/*/; do
    [[ -d "${dir}" ]] || continue
    dir="${dir%/}"
    upload_dir "${dir}" "${REMOTE}/${dir##*/}" held || return 1
    rmdir -- "${dir}" 2>/dev/null || true
  done
}

spool_kb() { du -sk "${WAL_DIR}" "${HELD_DIR}" | awk '{ total += $1 } END { print total + 0 }'; }

# Stops pg_receivewal once the spool reaches PITR_MAX_WAL_GB; receive_loop waits for it to drain.
enforce_limit() {
  if (($(spool_kb) >= MAX_SPOOL_KB)) && [[ -s "${STATE}/receiver.pid" ]]; then
    log "Upload backlog reached PITR_MAX_WAL_GB; pausing WAL streaming"
    kill -TERM "$(cat "${STATE}/receiver.pid")" 2>/dev/null || true
    rm -f -- "${STATE}/receiver.pid"
  fi
}

# Receives into WAL_DIR until the spool reaches PITR_MAX_WAL_GB, then waits for uploads to drain
# it. While paused, Postgres keeps the WAL for the slot, up to max_slot_wal_keep_size.
receive_loop() {
  while :; do
    if (($(spool_kb) >= MAX_SPOOL_KB)); then
      : >"${STATE}/paused"
      sleep 10
      continue
    fi
    rm -f -- "${STATE}/paused"
    if ! ensure_slot; then
      sleep 5
      continue
    fi
    pg_receivewal --directory="${WAL_DIR}" --slot="${SLOT}" --compress=gzip --no-loop &
    echo "$!" >"${STATE}/receiver.pid"
    wait "$!" || log "pg_receivewal stopped; reconnecting"
    sleep 5
  done
}

base_backup() {
  local stamp dest start end segment_bytes start_wal
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  dest="${ROOT}/base/${stamp}"
  log "Starting base backup ${stamp}"
  segment_bytes="$(sql "SELECT setting FROM pg_settings WHERE name = 'wal_segment_size'")"
  # -X fetch puts the WAL the backup needs inside it, so each base restores on its own.
  pg_basebackup --pgdata=- --format=tar --wal-method=fetch --compress=client-zstd \
    --checkpoint=spread --verbose 2>"${STATE}/base.log" |
    age --encrypt "${AGE_ARGS[@]}" |
    rclone rcat "${dest}/base.tar.zst.age" || {
    cat "${STATE}/base.log" >&2
    log "Base backup ${stamp} failed"
    return 1
  }
  start="$(sed -nE 's/.*write-ahead log start point: ([0-9A-F]+\/[0-9A-F]+) on timeline ([0-9]+).*/\1 \2/p' "${STATE}/base.log")"
  [[ -n "${start}" ]] || { cat "${STATE}/base.log" >&2; log "Base backup ${stamp} did not report its start"; return 1; }
  start_wal="$(wal_name "${start#* }" "${start% *}" "${segment_bytes}")"
  end="$(date +%s)"
  # COMPLETE is written last; a base without it is never restored and is pruned later.
  printf 'start_wal=%s\nend_time=%s\ntimeline=%s\n' "${start_wal}" "${end}" "${start#* }" |
    rclone rcat "${dest}/COMPLETE"
  echo "${end}" >"${STATE}/last-base"
  log "Base backup ${stamp} uploaded"
}

prune() {
  ((RETAIN_DAYS > 0)) || return 0
  local listing plan item
  listing="$(list_bases "${ROOT}")" || return 1
  listing+=$'\n'"$(lsf --files-only "${ROOT}/wal" | sed 's/^/wal /')" || return 1
  plan="$(plan_prune "$(date +%s)" "${RETAIN_DAYS}" <<<"${listing}")"
  local -a wal=()
  while read -r action item; do
    case "${action}" in
      purge) rclone purge "${ROOT}/${item}" || return 1 ;;
      delete) wal+=("${item#wal/}") ;;
    esac
  done <<<"${plan}"
  ((${#wal[@]})) || return 0
  printf '%s\n' "${wal[@]}" | rclone delete --files-from-raw - "${ROOT}/wal"
}

# Connects with the replication login, creating its slot on first use. A slot Postgres dropped for
# exceeding max_slot_wal_keep_size, or a new one, leaves a gap, so both force a new base backup.
# Local segments then predate what the new slot can stream, so they move to held/ to be uploaded
# without pg_receivewal resuming from them.
ensure_slot() {
  local status
  # A slot that has not streamed yet reserves no WAL, so its wal_status is null.
  status="$(sql "SELECT coalesce(wal_status, 'new') FROM pg_replication_slots WHERE slot_name = '${SLOT}'")" || return 1
  if [[ "${status}" == lost ]]; then
    log "The replication slot lost WAL it needed; recovery has a gap until the next base backup"
    sql "SELECT pg_drop_replication_slot('${SLOT}')" >/dev/null || return 1
    status=""
  fi
  [[ -z "${status}" ]] || return 0
  mkdir -p -- "${HELD_DIR}/${SYSID}" || return 1
  find "${WAL_DIR}" -maxdepth 1 -type f -exec mv -t "${HELD_DIR}/${SYSID}" -- {} + || return 1
  pg_receivewal --slot="${SLOT}" --create-slot --if-not-exists || return 1
  : >"${STATE}/base-now"
}

run() {
  archive_config
  mkdir -p -- "${WAL_DIR}" "${HELD_DIR}" "${STATE}"
  rm -f -- "${STATE}/paused" "${STATE}/receiver.pid"
  date +%s >"${STATE}/started"
  trap 'exit 0' TERM INT
  local source sysid timeline
  until source="$(identify 2>"${STATE}/connect.log")"; do
    touch "${STATE}/heartbeat"
    log "Waiting for the replication login: $(tail -n 1 "${STATE}/connect.log")"
    sleep 10
  done
  read -r sysid timeline <<<"${source}"
  SYSID="${sysid}"
  ROOT="${REMOTE}/${sysid}"
  if [[ -s "${STATE}/source" && "$(cat "${STATE}/source")" != "${source}" ]]; then
    local previous
    previous="$(awk '{ print $1 }' "${STATE}/source")"
    mkdir -p -- "${HELD_DIR}/${previous}"
    find "${WAL_DIR}" -maxdepth 1 -type f -exec mv -t "${HELD_DIR}/${previous}" -- {} +
  fi
  echo "${source}" >"${STATE}/source"
  rm -f -- "${STATE}/last-base" "${STATE}/base-now"
  # The newest base on this timeline; when storage cannot be listed, the next one is due now.
  local newest=""
  newest="$(list_bases "${ROOT}" | awk -v tl="${timeline}" '$1 == "base" && $5 == tl { end = $4 } END { print end }')" ||
    log "Cannot list base backups yet"
  [[ -z "${newest}" ]] || echo "${newest}" >"${STATE}/last-base"
  log "Archiving system ${sysid} timeline ${timeline} to ${ROOT}"

  # Before the first base backup, so that backup covers the slot instead of a second one following it.
  ensure_slot || log "Cannot create the replication slot yet; retrying"
  receive_loop &
  local base_pid="" last_attempt=0 upload_after=0 now last
  while :; do
    touch "${STATE}/heartbeat"
    now="$(date +%s)"
    # Retry a failed upload every 30 seconds rather than on every pass.
    if ((now >= upload_after)) && ! upload_ready; then upload_after=$((now + 30)); fi
    enforce_limit
    if [[ -n "${base_pid}" ]] && ! kill -0 "${base_pid}" 2>/dev/null; then
      if wait "${base_pid}"; then prune || log "Pruning old backups failed"; fi
      base_pid=""
    fi
    last="$(cat "${STATE}/last-base" 2>/dev/null || echo 0)"
    # A new slot starts a gap, so its base backup skips the retry wait.
    if [[ -z "${base_pid}" ]] && { [[ -e "${STATE}/base-now" ]] ||
      ((now - last >= BASE_INTERVAL && now - last_attempt >= BASE_RETRY)); }; then
      rm -f -- "${STATE}/base-now"
      last_attempt="${now}"
      base_backup &
      base_pid=$!
    fi
    sleep 5
  done
}

age_of() { echo $(($(date +%s) - $(stat -c %Y "$1"))); }

health() {
  local problems=() oldest status now last started
  now="$(date +%s)"
  if [[ ! -e "${STATE}/heartbeat" ]] || (($(age_of "${STATE}/heartbeat") > 120)); then
    problems+=("the archiver is not running")
  fi
  [[ ! -e "${STATE}/paused" ]] || problems+=("the upload backlog reached PITR_MAX_WAL_GB, so WAL streaming is paused")
  oldest="$(find "${WAL_DIR}" "${HELD_DIR}" -type f -regextype posix-extended -regex ".*/(${FINISHED})" \
    -printf '%T@\n' 2>/dev/null | sort -n | head -n 1)"
  if [[ -n "${oldest}" ]] && ((now - ${oldest%.*} > UPLOAD_STALE)); then
    problems+=("WAL uploads are stalled; the oldest waiting segment is $(((now - ${oldest%.*}) / 60)) minutes old")
  fi
  last="$(cat "${STATE}/last-base" 2>/dev/null || echo 0)"
  started="$(cat "${STATE}/started" 2>/dev/null || echo "${now}")"
  if ((last == 0 && now - started > 6 * 3600)); then
    problems+=("no base backup has completed")
  elif ((last > 0 && now - last > BASE_INTERVAL + 6 * 3600)); then
    problems+=("the last base backup is $(((now - last) / 3600)) hours old")
  fi
  if status="$(sql "SELECT active, wal_status, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) FROM pg_replication_slots WHERE slot_name = '${SLOT}'" 2>&1)"; then
    case "${status}" in
      "") problems+=("the replication slot ${SLOT} does not exist") ;;
      *"|lost|"*) problems+=("the replication slot ${SLOT} lost WAL") ;;
      f\|*) problems+=("nothing is streaming from the replication slot ${SLOT}") ;;
    esac
  else
    problems+=("cannot query Postgres: ${status}")
  fi
  if ((${#problems[@]})); then
    printf '%s\n' "${problems[@]}"
    return 1
  fi
  if ((last == 0)); then
    echo "ok: slot retains ${status##*|}; no base backup yet"
  else
    echo "ok: slot retains ${status##*|}; last base backup $(((now - last) / 3600))h ago"
  fi
}

restore() {
  local target="${1:?usage: rakazo-pitr restore latest|TIMESTAMP}" target_epoch=latest target_pg=""
  storage_config
  if [[ "${target}" != latest ]]; then
    # One parser for both the base choice and Postgres, keeping fractions of a second.
    target_pg="$(date -u -d "${target}" '+%Y-%m-%d %H:%M:%S.%N+00' 2>/dev/null)" || die "Cannot read the target time ${target}"
    target_epoch="$(date -u -d "${target_pg}" +%s)"
  fi
  cat >"${IDENTITY}"
  [[ -s "${IDENTITY}" ]] || die "Pass the age identity file on stdin"
  local sysid="${PITR_SYSTEM_ID:-}" systems
  if [[ -z "${sysid}" ]]; then
    systems="$(lsf --dirs-only "${REMOTE}" | tr -d / | grep -E '^[0-9]+$' || true)"
    [[ -n "${systems}" ]] || die "No backups found under ${REMOTE}"
    (($(wc -l <<<"${systems}") == 1)) ||
      die "Backups from several clusters are stored here; set PITR_SYSTEM_ID to one of: $(tr '\n' ' ' <<<"${systems}")"
    sysid="${systems}"
  fi
  ROOT="${REMOTE}/${sysid}"
  local bases chosen stamp start_wal earliest
  bases="$(list_bases "${ROOT}")"
  if ! chosen="$(plan_restore "${target_epoch}" <<<"${bases}")"; then
    earliest="$(awk '$1 == "base" { print $4; exit }' <<<"${bases}")"
    [[ -n "${earliest}" ]] || die "No finished base backup under ${ROOT}"
    die "No base backup finished before ${target}; the earliest recoverable time is $(date -u -d "@${earliest}")"
  fi
  read -r stamp start_wal _ <<<"${chosen}"

  if [[ -e "${PGDATA}" ]]; then
    local aside
    aside="${PGDATA}.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
    mv -- "${PGDATA}" "${aside}"
    log "Moved the existing cluster to ${aside}"
  fi
  [[ -d "${PGDATA%/*}" ]] || install -d -m 755 -- "${PGDATA%/*}"
  install -d -m 700 -- "${PGDATA}" "${RESTORE_WAL}"
  # The image's entrypoint leaves the cluster's parent directory to root, so only root can move the
  # old cluster aside; Postgres itself must not run as root.
  if ((EUID == 0)); then
    chown postgres:postgres -- "${PGDATA}" "${RESTORE_WAL}" "${IDENTITY}"
    exec gosu postgres "$0" recover "${ROOT}" "${stamp}" "${start_wal}" "${target_pg}"
  fi
  recover "${ROOT}" "${stamp}" "${start_wal}" "${target_pg}"
}

# The unprivileged half of restore: unpack the base, fetch the WAL after it, and replay.
recover() {
  local root="$1" stamp="$2" start_wal="$3" target_pg="$4"
  log "Restoring base backup ${stamp}"
  rclone cat "${root}/base/${stamp}/base.tar.zst.age" | age --decrypt -i "${IDENTITY}" | zstd -dc | tar -x -C "${PGDATA}"

  # Every segment from the base's start on, plus timeline histories.
  lsf --files-only "${root}/wal" | awk -v from="${start_wal:8:16}" \
    '/^[0-9A-F]{8}\.history\.gz\.age$/ || (/^[0-9A-F]{24}\.gz\.age$/ && substr($0, 9, 16) >= from)' >/tmp/pitr-wal
  log "Fetching $(wc -l </tmp/pitr-wal) WAL files"
  rclone copy --files-from-raw /tmp/pitr-wal "${root}/wal" "${RESTORE_WAL}"

  touch "${PGDATA}/recovery.signal"
  local -a settings=(-c listen_addresses= -c unix_socket_directories=/tmp -c archive_mode=off
    -c "restore_command=rakazo-pitr fetch-wal %f %p" -c recovery_target_action=promote)
  [[ -z "${target_pg}" ]] || settings+=(-c "recovery_target_time=${target_pg}")
  log "Recovering to ${target_pg:-the end of the archive}"
  postgres -D "${PGDATA}" "${settings[@]}" >"${RESTORE_WAL}/recovery.log" 2>&1 &
  local server=$!
  # Logged only once recovery has finished and the server has promoted; while replaying it says
  # "read-only connections".
  until grep -q 'database system is ready to accept connections' "${RESTORE_WAL}/recovery.log"; do
    if ! kill -0 "${server}" 2>/dev/null; then
      tail -n 20 "${RESTORE_WAL}/recovery.log" >&2
      die "Recovery failed; the restored files are left in ${PGDATA}"
    fi
    sleep 1
  done
  grep -E 'recovery stopping|last completed transaction|redo done|selected new timeline' "${RESTORE_WAL}/recovery.log" >&2 || true
  pg_ctl -D "${PGDATA}" -w stop -m fast >/dev/null
  rm -rf -- "${RESTORE_WAL}" "${IDENTITY}"
  log "Restored to ${target_pg:-the latest archived transaction}"
}

fetch_wal() {
  local source="${RESTORE_WAL}/$1.gz.age"
  [[ -f "${source}" ]] || exit 1
  age --decrypt -i "${IDENTITY}" "${source}" | gzip -dc >"$2.tmp"
  mv -- "$2.tmp" "$2"
}

case "${1:-}" in
  run) run ;;
  health) health ;;
  restore) restore "${2:-}" ;;
  recover) recover "$2" "$3" "$4" "${5:-}" ;;
  fetch-wal) fetch_wal "$2" "$3" ;;
  wal-name) wal_name "$2" "$3" "$4" ;;
  plan-prune) plan_prune "$2" "$3" ;;
  plan-restore) plan_restore "$2" ;;
  list-bases) storage_config && list_bases "${REMOTE}/$2" ;;
  *) die "usage: rakazo-pitr run|health|restore TARGET" ;;
esac
