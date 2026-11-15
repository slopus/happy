#!/usr/bin/env bash
# Execute the documented startup with a fake Docker CLI; no daemon or network.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

awk '
  /^## Digest-verified Hub mirror startup/ { section=1; next }
  section && /^```bash/ { code=1; next }
  code && /^```/ { exit }
  code { print }
' "$root/../../docs/self-host-restricted-network.md" |
  sed -e "s/<trusted-postgres-digest>/$(printf '%064d' 1)/g" \
      -e "s/<trusted-busybox-digest>/$(printf '%064d' 2)/g" >"$scratch/start.sh"
[[ -s "$scratch/start.sh" ]] || fail "missing documented startup"
bash -n "$scratch/start.sh"

docker() {
  case "$*" in
    'compose --env-file .env -f docker-compose.images.yml pull')
      echo pull >>"$MIRROR_TEST_LOG"
      [[ "$MIRROR_TEST_CASE" != pull_failure ]]
      ;;
    'image inspect '*)
      echo inspect >>"$MIRROR_TEST_LOG"
      local image_ref="${!#}"
      if [[ "$MIRROR_TEST_CASE" == mismatch && "$image_ref" == *busybox* ]]; then
        echo 'registry.example.com/library/busybox@sha256:wrong'
      elif [[ "$MIRROR_TEST_CASE" != missing_digest ]]; then
        printf '%s\n' "$image_ref"
      fi
      # A failure must stop startup even if stdout contained a matching digest.
      [[ "$MIRROR_TEST_CASE" != inspect_failure ]]
      ;;
    'compose up --help')
      [[ "$MIRROR_TEST_CASE" == unsupported ]] || echo '--pull policy'
      return 0
      ;;
    'compose --env-file .env -f docker-compose.images.yml up -d --pull never')
      echo start >>"$MIRROR_TEST_LOG"
      ;;
    *) echo "unexpected Docker command: $*" >&2; return 1 ;;
  esac
}
export -f docker
export MIRROR_TEST_LOG="$scratch/calls"
for MIRROR_TEST_CASE in success pull_failure mismatch missing_digest inspect_failure unsupported; do
  export MIRROR_TEST_CASE
  : >"$MIRROR_TEST_LOG"
  status=0
  bash "$scratch/start.sh" >"$scratch/output" 2>&1 || status=$?
  if [[ "$MIRROR_TEST_CASE" == success ]]; then
    [[ "$status" == 0 ]] || fail "valid digests rejected"
    [[ "$(cat "$MIRROR_TEST_LOG")" == $'pull\ninspect\ninspect\nstart' ]] || fail "wrong startup order"
  else
    [[ "$status" != 0 ]] || fail "$MIRROR_TEST_CASE succeeded"
    if grep -q '^start$' "$MIRROR_TEST_LOG"; then
      fail "$MIRROR_TEST_CASE started containers"
    fi
  fi
done
echo "ok"
