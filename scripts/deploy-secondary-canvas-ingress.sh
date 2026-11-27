#!/usr/bin/env bash
set -euo pipefail
# This secondary is authorized only for the project canvas. The shared OSS Web
# entry and the primary deployment contract remain under deploy-web.sh.
test "${GITHUB_REF:-}" = 'refs/heads/main'
test "${PAWS_SECONDARY_WEB_ORIGIN:-}" = 'https://121.43.32.242:8443'
test "${PAWS_SECONDARY_DEPLOY_HOST:-}" = 'root@121.43.32.242'
test "${PAWS_SECONDARY_DEPLOY_PORT:-}" = '22'
[[ "${GITHUB_SHA:-}" =~ ^[a-f0-9]{40}$ ]] || exit 1
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [ "${1:-}" = '--rollback' ]; then
  backup="${2:?Missing backup}"
  [[ "$backup" =~ ^/etc/caddy/Caddyfile\.paws-secondary-canvas\.previous-[a-f0-9]{40}-[0-9]+-[0-9]+$ ]] || exit 1
  ssh -p "$PAWS_SECONDARY_DEPLOY_PORT" "$PAWS_SECONDARY_DEPLOY_HOST" bash -s -- "$backup" <<'REMOTE'
set -euo pipefail
backup="$1"
[[ "$backup" =~ ^/etc/caddy/Caddyfile\.paws-secondary-canvas\.previous-[a-f0-9]{40}-[0-9]+-[0-9]+$ ]] || exit 1
config=/etc/caddy/Caddyfile
test -f "$backup"
caddy validate --config "$backup" --adapter caddyfile
cp -p -- "$backup" /etc/caddy/.paws-secondary-canvas-rollback
mv -f -- /etc/caddy/.paws-secondary-canvas-rollback "$config"
timeout 30s caddy reload --config "$config" --adapter caddyfile
systemctl is-active --quiet caddy
REMOTE
  exit 0
fi
[[ $# -eq 0 ]] || exit 1
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
# SSH strictly checks the pinned host key configured by the Web workflow.
ssh -p "$PAWS_SECONDARY_DEPLOY_PORT" "$PAWS_SECONDARY_DEPLOY_HOST" 'cat /etc/caddy/Caddyfile' > "$work/current"
change="$(node "$SCRIPT_DIR/configure-production-web-caddy.mjs" "$work/current" "$work/next" --secondary-canvas)"
if [ "$change" = 'unchanged' ]; then
  echo 'backup_path=' >> "$GITHUB_OUTPUT"
  exit 0
fi
test "$change" = 'changed'
run_id="${GITHUB_RUN_ID:?Missing Actions run id}"
attempt="${GITHUB_RUN_ATTEMPT:?Missing Actions run attempt}"
[[ "$run_id" =~ ^[0-9]+$ && "$attempt" =~ ^[0-9]+$ ]] || exit 1
expected="$(shasum -a 256 "$work/current" | cut -d' ' -f1)"
candidate="/tmp/paws-secondary-canvas-$GITHUB_SHA-$run_id-$attempt"
backup="/etc/caddy/Caddyfile.paws-secondary-canvas.previous-$GITHUB_SHA-$run_id-$attempt"
scp -P "$PAWS_SECONDARY_DEPLOY_PORT" "$work/next" "$PAWS_SECONDARY_DEPLOY_HOST:$candidate"
ssh -p "$PAWS_SECONDARY_DEPLOY_PORT" "$PAWS_SECONDARY_DEPLOY_HOST" bash -s -- "$candidate" "$backup" "$expected" <<'REMOTE'
set -euo pipefail
candidate="$1"; backup="$2"; expected="$3"
config=/etc/caddy/Caddyfile
trap 'rm -f -- "$candidate" /etc/caddy/.paws-secondary-canvas-next' EXIT
caddy validate --config "$candidate" --adapter caddyfile
test ! -e "$backup"
test "$(sha256sum "$config" | cut -d' ' -f1)" = "$expected"
cp -p -- "$config" "$backup"
test "$(sha256sum "$backup" | cut -d' ' -f1)" = "$expected"
install -m 644 -- "$candidate" /etc/caddy/.paws-secondary-canvas-next
test "$(sha256sum "$config" | cut -d' ' -f1)" = "$expected"
mv -f -- /etc/caddy/.paws-secondary-canvas-next "$config"
if ! timeout 30s caddy reload --config "$config" --adapter caddyfile || ! systemctl is-active --quiet caddy; then
  cp -p -- "$backup" /etc/caddy/.paws-secondary-canvas-next
  mv -f -- /etc/caddy/.paws-secondary-canvas-next "$config"
  timeout 30s caddy reload --config "$config" --adapter caddyfile
  exit 1
fi
REMOTE
# Output only after the unique backup exists and activation completed.
echo "backup_path=$backup" >> "$GITHUB_OUTPUT"
