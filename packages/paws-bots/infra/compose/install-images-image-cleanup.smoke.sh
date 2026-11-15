#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
src="$root/install-images.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/install-images-cleanup-smoke.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

setup_work() {
  local work="$1"
  mkdir -p "$work/bin" "$work/cwd"
  cat > "$work/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
log="${STUB_DOCKER_LOG:?}"
printf 'docker %s\n' "$*" >> "$log"
if [[ "${1:-}" == image ]]; then
  case "${2:-}" in
    ls)
      cat <<'EOF'
sha256:app-current ghcr.io/elie222/rakazo/app edge
sha256:app-old ghcr.io/elie222/rakazo/app <none>
sha256:computer-old ghcr.io/elie222/rakazo/computer <none>
sha256:computer-in-use ghcr.io/elie222/rakazo/computer <none>
sha256:app-pinned ghcr.io/elie222/rakazo/app sha-0123
sha256:postgres-old postgres <none>
sha256:mirror-old registry.example.com:5000/busybox <none>
sha256:other-old example/other-project <none>
sha256:other-current example/other-project latest
sha256:prefix-old ghcr.io/elie222/rakazo/app-fork <none>
EOF
      ;;
    rm)
      [[ "${3:-}" != sha256:computer-in-use ]] || { echo "image is being used by a container" >&2; exit 1; }
      ;;
  esac
  exit 0
fi
[[ "${1:-}" == compose ]] || exit 1
shift
for a in "$@"; do
  case "$a" in
    --help) echo "--pull --wait --wait-timeout"; exit 0 ;;
    config)
      if [[ " $* " == *" --images "* ]]; then
        printf '%s\n' \
          ghcr.io/elie222/rakazo/app:edge \
          ghcr.io/elie222/rakazo/computer:edge \
          'postgres:16@sha256:e17e86066e5ef83e0952a9347f5c792b7ece00972e2aa787a6986f471b3dd3d5' \
          registry.example.com:5000/busybox
        exit 0
      fi
      cat >/dev/null || true
      printf '%s\n' POSTGRES_PASSWORD=x POSTGRES_APP_PASSWORD=x BETTER_AUTH_SECRET=x \
        ENCRYPTION_KEY=x SCREEN_PROXY_SECRET=x SANDBOX_SUPERVISOR_TOKEN=x
      exit 0
      ;;
    up) [[ -z "${STUB_UP_FAILS:-}" ]] || exit 1 ;;
  esac
done
exit 0
STUB
  chmod +x "$work/bin/docker"
  : > "$work/cwd/docker-compose.images.yml"
  : > "$work/cwd/.env.images.example"
  printf '%s\n' POSTGRES_APP_PASSWORD=x SANDBOX_COMPUTER_EGRESS=open > "$work/cwd/.env"
  : > "$work/docker.log"
}

run_install() {
  local work="$1"
  (
    export STUB_DOCKER_LOG="$work/docker.log" PATH="$work/bin:$PATH"
    cd "$work/cwd"
    bash "$src" --offline
  )
}

setup_work "$tmp/ok"
run_install "$tmp/ok" >/dev/null 2>&1 || fail "install failed"
removed="$(sed -n 's/^docker image rm //p' "$tmp/ok/docker.log" | sort | tr '\n' ' ')"
expected="sha256:app-old sha256:computer-in-use sha256:computer-old sha256:mirror-old sha256:postgres-old "
[[ "$removed" == "$expected" ]] || fail "removed [$removed], expected [$expected]"

setup_work "$tmp/up-fails"
(export STUB_UP_FAILS=1; run_install "$tmp/up-fails" >/dev/null 2>&1) && fail "install should fail when up fails"
! grep -q '^docker image rm' "$tmp/up-fails/docker.log" || fail "images were removed after a failed up"

echo "ok"
