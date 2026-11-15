#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
src="$root/install-images.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }
set +e
out="$(bash "$src" --not-a-flag 2>&1)"
code=$?
set -e
[[ "$code" -eq 2 ]] || fail "expected exit 2 for unknown flag, got $code"
[[ "$out" == *"Usage: bash install-images.sh"* ]] || fail "usage missing from stderr"
bash -n "$src" || fail "bash -n failed"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/install-images-smoke.XXXXXX")"
cleanup_tmp() { rm -rf "$tmp"; }
trap cleanup_tmp EXIT

write_stubs() {
  local bin="$1"
  mkdir -p "$bin"
  cat > "$bin/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
log="${STUB_DOCKER_LOG:?}"
{
  printf 'docker'
  for a in "$@"; do
    printf ' %s' "$a"
  done
  printf '\n'
} >> "$log"

if [[ "${1:-}" != compose ]]; then
  echo "STUB: unexpected docker $*" >&2
  exit 1
fi
shift

help=false
short=false
verb=""
for a in "$@"; do
  case "$a" in
    --help|-h) help=true ;;
    --short) short=true ;;
    version|up|pull|config)
      if [[ -z "$verb" ]]; then
        verb="$a"
      fi
      ;;
  esac
done

echo "VERB=${verb:-none}" >> "$log"

if [[ "$verb" == config ]]; then
  cat >/dev/null || true
fi

if [[ "$help" == true ]]; then
  printf '%s\n' "${STUB_COMPOSE_UP_HELP:-Usage: docker compose up

Options:
  --pull string     Pull image before running
  --wait
  --wait-timeout int
}"
  exit 0
fi

case "$verb" in
  version)
    if [[ "$short" == true ]]; then
      printf '%s\n' "${STUB_COMPOSE_SHORT:-2.24.0}"
    else
      echo "Docker Compose version v${STUB_COMPOSE_SHORT:-2.24.0}"
    fi
    ;;
  config)
    cat <<'EOF'
POSTGRES_PASSWORD=test-postgres
POSTGRES_APP_PASSWORD=test-app-postgres
BETTER_AUTH_SECRET=test-auth-secret
ENCRYPTION_KEY=test-encryption-key
SCREEN_PROXY_SECRET=test-screen-secret
SANDBOX_SUPERVISOR_TOKEN=test-supervisor-token
EOF
    ;;
  pull|up)
    ;;
  *)
    echo "STUB: unexpected compose verb ${verb:-none} $*" >&2
    exit 1
    ;;
esac
STUB
  cat > "$bin/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
log="${STUB_CURL_LOG:?}"
{
  printf 'curl'
  for a in "$@"; do
    printf ' %s' "$a"
  done
  printf '\n'
} >> "$log"
if [[ " $* " == *" --help "* ]]; then
  echo "--retry-all-errors"
  exit 0
fi
out=""
prev=""
for a in "$@"; do
  if [[ "$prev" == "-o" ]]; then
    out="$a"
  fi
  prev="$a"
done
if [[ -n "$out" ]]; then
  printf 'stub-download\n' > "$out"
  exit 0
fi
exit 1
STUB
  chmod +x "$bin/docker" "$bin/curl"
}

setup_work() {
  local work="$1"
  mkdir -p "$work/cwd"
  write_stubs "$work/bin"
  : > "$work/cwd/docker-compose.images.yml"
  : > "$work/cwd/.env.images.example"
  cat > "$work/cwd/.env" <<'EOF'
POSTGRES_PASSWORD=test-postgres
POSTGRES_APP_PASSWORD=test-app-postgres
BETTER_AUTH_SECRET=test-auth-secret
ENCRYPTION_KEY=test-encryption-key
SCREEN_PROXY_SECRET=test-screen-secret
SANDBOX_SUPERVISOR_TOKEN=test-supervisor-token
SANDBOX_COMPUTER_EGRESS=open
EOF
  : > "$work/docker.log"
  : > "$work/curl.log"
}

run_install() {
  local work="$1"
  shift
  (
    export STUB_DOCKER_LOG="$work/docker.log"
    export STUB_CURL_LOG="$work/curl.log"
    export PATH="$work/bin:$PATH"
    cd "$work/cwd"
    bash "$src" "$@"
  )
}

has_compose_pull() {
  grep -q 'VERB=pull' "$1/docker.log"
}

has_up_pull_never() {
  grep -F -e 'VERB=up' "$1/docker.log" >/dev/null \
    && grep -F -e ' --pull never' "$1/docker.log" >/dev/null
}

# Flags accepted: --offline takes the local/pull-never path (no curl, no compose pull).
setup_work "$tmp/offline"
set +e
offline_out="$(run_install "$tmp/offline" --offline 2>&1)"
offline_code=$?
set -e
[[ "$offline_code" -eq 0 ]] || fail "--offline exited $offline_code: $offline_out"
[[ "$offline_out" != *"Usage: bash install-images.sh"* ]] || fail "--offline was rejected as unknown"
[[ "$offline_out" == *"Using local docker-compose.images.yml"* ]] || fail "--offline did not keep local compose file"
[[ "$offline_out" == *"Using local .env.images.example"* ]] || fail "--offline did not keep local env example"
[[ "$offline_out" == *"Skipping image pull"* ]] || fail "--offline did not skip image pull"
[[ "$offline_out" == *"Rakazo is starting"* ]] || fail "--offline did not start"
[[ ! -s "$tmp/offline/curl.log" ]] || fail "--offline should not curl when files are local: $(cat "$tmp/offline/curl.log")"
has_compose_pull "$tmp/offline" && fail "--offline should not run compose pull"
has_up_pull_never "$tmp/offline" || fail "--offline should pass --pull never to compose up: $(cat "$tmp/offline/docker.log")"

for missing_input in docker-compose.images.yml .env.images.example; do
  work="$tmp/missing-${missing_input}"
  setup_work "$work"
  rm -- "$work/cwd/$missing_input"
  set +e
  missing_out="$(run_install "$work" --offline 2>&1)"
  missing_code=$?
  set -e
  [[ "$missing_code" -ne 0 ]] || fail "--offline accepted missing $missing_input"
  [[ "$missing_out" == *"$missing_input"* ]] || fail "--offline did not identify missing $missing_input"
  [[ ! -s "$work/curl.log" ]] || fail "--offline attempted a network request for missing $missing_input"
  has_compose_pull "$work" && fail "--offline pulled images with missing $missing_input"
  [[ ! -s "$work/docker.log" ]] || fail "--offline invoked Compose with missing $missing_input"
done

setup_work "$tmp/local-missing"
rm -- "$tmp/local-missing/cwd/docker-compose.images.yml"
local_out="$(run_install "$tmp/local-missing" --local 2>&1)"
[[ -s "$tmp/local-missing/curl.log" ]] || fail "--local should download missing files"
has_compose_pull "$tmp/local-missing" || fail "--local should still pull images"
grep -q 'VERB=up' "$tmp/local-missing/docker.log" || fail "--local should start services"

# --pull-never is accepted and skips pull (may still download Compose files).
setup_work "$tmp/pull-never"
set +e
pull_never_out="$(run_install "$tmp/pull-never" --pull-never 2>&1)"
pull_never_code=$?
set -e
[[ "$pull_never_code" -eq 0 ]] || fail "--pull-never exited $pull_never_code: $pull_never_out"
[[ "$pull_never_out" != *"Usage: bash install-images.sh"* ]] || fail "--pull-never was rejected as unknown"
[[ "$pull_never_out" == *"Skipping image pull"* ]] || fail "--pull-never did not skip image pull"
has_compose_pull "$tmp/pull-never" && fail "--pull-never should not run compose pull"
has_up_pull_never "$tmp/pull-never" || fail "--pull-never should pass --pull never to compose up"

# Old Compose without up --pull: warn and continue instead of hard-fail.
setup_work "$tmp/old"
export STUB_COMPOSE_UP_HELP='Usage: docker compose up
  --wait
  --wait-timeout int
'
export STUB_COMPOSE_SHORT='2.10.1'
set +e
old_out="$(run_install "$tmp/old" --offline 2>&1)"
old_code=$?
set -e
unset STUB_COMPOSE_UP_HELP STUB_COMPOSE_SHORT
[[ "$old_code" -eq 0 ]] || fail "old Compose --offline exited $old_code: $old_out"
[[ "$old_out" == *"cannot enforce pull-never on this Compose version; startup fails if an image is missing locally"* ]] \
  || fail "old Compose --offline missing soft warning: $old_out"
[[ "$old_out" != *"Rakazo setup failed:"* ]] || fail "old Compose --offline should not hard-fail: $old_out"
[[ "$old_out" == *"Rakazo is starting"* ]] || fail "old Compose --offline should continue: $old_out"
has_compose_pull "$tmp/old" && fail "old Compose --offline should not run compose pull"
if grep -F -e ' --pull never' "$tmp/old/docker.log" >/dev/null; then
  fail "old Compose up should not receive --pull never: $(cat "$tmp/old/docker.log")"
fi
grep -q 'VERB=up' "$tmp/old/docker.log" || fail "old Compose --offline should still run compose up"

# Empty up arrays under set -u must not abort a normal install (bash 3.2).
setup_work "$tmp/default"
set +e
default_out="$(run_install "$tmp/default" 2>&1)"
default_code=$?
set -e
[[ "$default_code" -eq 0 ]] || fail "default install exited $default_code: $default_out"
[[ "$default_out" != *"unbound variable"* ]] || fail "empty array expansion aborted: $default_out"
has_compose_pull "$tmp/default" || fail "default install should run compose pull"
grep -q 'VERB=up' "$tmp/default/docker.log" || fail "default install should run compose up"

# A setting the Compose file does not name is reported instead of silently dropped.
setup_work "$tmp/unpassed"
printf '  TELEGRAM_BOT_TOKEN:\n  POSTGRES_PASSWORD: x\n' > "$tmp/unpassed/cwd/docker-compose.images.yml"
printf 'TELEGRAM_BOT_TOKEN=1\nTELEGRAM_BOT_TOKEN_SUPPORT=2\nCOMPOSE_PROJECT_NAME=x\n' >> "$tmp/unpassed/cwd/.env"
unpassed_out="$(run_install "$tmp/unpassed" --offline 2>&1)"
[[ "$unpassed_out" == *"no container receives these .env settings:"*"TELEGRAM_BOT_TOKEN_SUPPORT"* ]] ||
  fail "custom setting was not reported: $unpassed_out"
[[ "$unpassed_out" != *" TELEGRAM_BOT_TOKEN "* && "$unpassed_out" != *" TELEGRAM_BOT_TOKEN." ]] ||
  fail "a listed setting was reported: $unpassed_out"
[[ "$unpassed_out" != *"COMPOSE_PROJECT_NAME"* ]] || fail "a Compose setting was reported"

# An override file next to the base file is layered into every command and counts as listing.
printf 'services:\n  api:\n    environment:\n      TELEGRAM_BOT_TOKEN_SUPPORT:\n' \
  > "$tmp/unpassed/cwd/docker-compose.override.yml"
: > "$tmp/unpassed/docker.log"
override_out="$(run_install "$tmp/unpassed" --offline 2>&1)"
[[ "$override_out" != *"TELEGRAM_BOT_TOKEN_SUPPORT"* ]] ||
  fail "a setting listed in the override was reported: $override_out"
grep -qF -e '-f docker-compose.override.yml up' "$tmp/unpassed/docker.log" ||
  fail "compose up did not layer the override: $(cat "$tmp/unpassed/docker.log")"

# The Compose files come from the pinned release, whichever way the tag was pinned.
unset RAKAZO_IMAGE_TAG
download_ref() {
  local name="$1" image_tag="${2:-}"
  shift 2
  setup_work "$tmp/$name"
  (
    [[ -z "$image_tag" ]] || export RAKAZO_IMAGE_TAG="$image_tag"
    run_install "$tmp/$name" "$@" >/dev/null 2>&1
  ) || fail "$name install failed"
  grep -F 'docker-compose.images.yml' "$tmp/$name/curl.log" | grep -oE 'rakazo/[^/]+/infra/compose' | sort -u
}
ref="$(download_ref untagged "")"
[[ "$ref" == "rakazo/main/infra/compose" ]] || fail "no pin should use main, got: $ref"
ref="$(download_ref shell-pin v0.8.0)"
[[ "$ref" == "rakazo/v0.8.0/infra/compose" ]] || fail "shell pin should use its tag, got: $ref"
ref="$(download_ref shell-edge edge)"
[[ "$ref" == "rakazo/main/infra/compose" ]] || fail "edge should use main, got: $ref"
ref="$(download_ref shell-custom v0.8.0-custom)"
[[ "$ref" == "rakazo/main/infra/compose" ]] || fail "a tag that is not a release should use main, got: $ref"

setup_work "$tmp/env-pin"
printf 'RAKAZO_IMAGE_TAG=edge\nexport RAKAZO_IMAGE_TAG="v0.7.0" # pinned\r\n' >> "$tmp/env-pin/cwd/.env"
run_install "$tmp/env-pin" >/dev/null 2>&1 || fail "env-pin install failed"
grep -qF 'rakazo/v0.7.0/infra/compose/docker-compose.images.yml' "$tmp/env-pin/curl.log" ||
  fail ".env pin should use its tag: $(cat "$tmp/env-pin/curl.log")"

setup_work "$tmp/shell-wins"
printf 'RAKAZO_IMAGE_TAG=v0.7.0\n' >> "$tmp/shell-wins/cwd/.env"
(export RAKAZO_IMAGE_TAG=v0.8.0; run_install "$tmp/shell-wins" >/dev/null 2>&1) || fail "shell-wins install failed"
grep -qF 'rakazo/v0.8.0/infra/compose/docker-compose.images.yml' "$tmp/shell-wins/curl.log" ||
  fail "the shell should win over .env, as in Compose: $(cat "$tmp/shell-wins/curl.log")"

setup_work "$tmp/env-spaces"
printf "RAKAZO_IMAGE_TAG=v0.6.0\\nexport RAKAZO_IMAGE_TAG = 'v0.7.0'\\n" >> "$tmp/env-spaces/cwd/.env"
run_install "$tmp/env-spaces" >/dev/null 2>&1 || fail "env-spaces install failed"
grep -qF 'rakazo/v0.7.0/infra/compose/docker-compose.images.yml' "$tmp/env-spaces/curl.log" ||
  fail ".env pin with spaces should use its tag: $(cat "$tmp/env-spaces/curl.log")"

setup_work "$tmp/shell-empty"
printf 'RAKAZO_IMAGE_TAG=v0.7.0\n' >> "$tmp/shell-empty/cwd/.env"
(export RAKAZO_IMAGE_TAG=; run_install "$tmp/shell-empty" >/dev/null 2>&1) || fail "shell-empty install failed"
grep -qF 'rakazo/main/infra/compose/docker-compose.images.yml' "$tmp/shell-empty/curl.log" ||
  fail "an empty shell value should win over .env, as in Compose: $(cat "$tmp/shell-empty/curl.log")"

setup_work "$tmp/mirror"
printf 'RAKAZO_IMAGE_TAG=v0.7.0\n' >> "$tmp/mirror/cwd/.env"
(export RAKAZO_DOWNLOAD_BASE=https://mirror.example/compose; run_install "$tmp/mirror" >/dev/null 2>&1) || fail "mirror install failed"
grep -qF 'https://mirror.example/compose/docker-compose.images.yml' "$tmp/mirror/curl.log" ||
  fail "RAKAZO_DOWNLOAD_BASE should win: $(cat "$tmp/mirror/curl.log")"

echo "ok"
