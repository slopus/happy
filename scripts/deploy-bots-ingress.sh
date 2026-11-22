#!/usr/bin/env bash
set -euo pipefail
# The existing main-only Web workflow supplies its already-authorized SSH identity.
test "${GITHUB_REF:-}" = 'refs/heads/main'
test "${PAWS_DEPLOY_HOST:-}" = 'root@47.115.228.20'
test "${PAWS_DEPLOY_PORT:-}" = '22'
test "${GITHUB_SHA:-}" != ''
if [ "${1:-}" = '--rollback' ]; then
  backup="${2:?Missing backup}"
  case "$backup" in /etc/caddy/Caddyfile.paws-bots.previous-*) ;; *) exit 1;; esac
  ssh -p "$PAWS_DEPLOY_PORT" "$PAWS_DEPLOY_HOST" bash -s -- "$backup" <<'REMOTE'
set -euo pipefail
backup="$1"
case "$backup" in /etc/caddy/Caddyfile.paws-bots.previous-*) ;; *) exit 1;; esac
test -f "$backup"
caddy validate --config "$backup" --adapter caddyfile
cp -p -- "$backup" /etc/caddy/.paws-bots-rollback
mv -f -- /etc/caddy/.paws-bots-rollback /etc/caddy/Caddyfile
timeout 30s caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl is-active --quiet caddy
REMOTE
  exit 0
fi
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
ssh -p "$PAWS_DEPLOY_PORT" "$PAWS_DEPLOY_HOST" 'cat /etc/caddy/Caddyfile' > "$work/current"
ssh -p "$PAWS_DEPLOY_PORT" "$PAWS_DEPLOY_HOST" 'caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile' > "$work/adapted.json"
change="$(node scripts/configure-production-bots-caddy.mjs "$work/current" "$work/adapted.json" "$work/next")"
if [ "$change" = 'changed' ]; then
  expected="$(sha256sum "$work/current" | cut -d' ' -f1)"
  candidate="/tmp/paws-bots-caddy-$GITHUB_SHA"
  run_id="${GITHUB_RUN_ID:?Missing Actions run id}"
  attempt="${GITHUB_RUN_ATTEMPT:?Missing Actions run attempt}"
  [[ "$run_id" =~ ^[0-9]+$ && "$attempt" =~ ^[0-9]+$ ]]
  backup="/etc/caddy/Caddyfile.paws-bots.previous-$GITHUB_SHA-$run_id-$attempt"
  scp -P "$PAWS_DEPLOY_PORT" "$work/next" "$PAWS_DEPLOY_HOST:$candidate"
  ssh -p "$PAWS_DEPLOY_PORT" "$PAWS_DEPLOY_HOST" bash -s -- "$candidate" "$backup" "$expected" <<'REMOTE'
set -euo pipefail
candidate="$1"; backup="$2"; expected="$3"
config=/etc/caddy/Caddyfile
trap 'rm -f -- "$candidate" /etc/caddy/.paws-bots-next' EXIT
# The current native services must be reachable before adding a public listener.
curl --fail --silent --show-error --max-time 15 http://100.116.134.122:3491/ > /dev/null
caddy validate --config "$candidate" --adapter caddyfile
test ! -e "$backup"
test "$(sha256sum "$config" | cut -d' ' -f1)" = "$expected"
cp -p -- "$config" "$backup"
test "$(sha256sum "$backup" | cut -d' ' -f1)" = "$expected"
install -m 644 -- "$candidate" /etc/caddy/.paws-bots-next
test "$(sha256sum "$config" | cut -d' ' -f1)" = "$expected"
mv -f -- /etc/caddy/.paws-bots-next "$config"
if ! timeout 30s caddy reload --config "$config" --adapter caddyfile || ! systemctl is-active --quiet caddy; then
  cp -p -- "$backup" /etc/caddy/.paws-bots-next
  mv -f -- /etc/caddy/.paws-bots-next "$config"
  timeout 30s caddy reload --config "$config" --adapter caddyfile
  exit 1
fi
REMOTE
  # The remote apply has completed and its unique backup really exists.
  echo "backup_path=$backup" >> "$GITHUB_OUTPUT"
elif [ "$change" = 'unchanged' ]; then
  echo 'backup_path=' >> "$GITHUB_OUTPUT"
else
  exit 1
fi
if ! public_status="$(curl --silent --show-error --max-time 20 --output "$work/bots-health.json" --write-out '%{http_code}' https://47.115.228.20:8445/)"; then
  echo '::error::The Bots public health request failed before receiving a valid HTTP response.' >&2
  exit 1
fi
if [ "$public_status" = '200' ]; then
  echo 'Bots dedicated HTTPS ingress verified; computers remain disabled.'
elif [ "$change" = 'unchanged' ] && [ "$public_status" = '502' ] && node --input-type=commonjs - "$work/bots-health.json" <<'NODE'
const fs = require('node:fs');
try {
  const body = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  process.exit(body && Object.keys(body).length === 1 && body.error === 'Rakazo runtime is unavailable' ? 0 : 1);
} catch { process.exit(1); }
NODE
then
  # Keep transport, TLS and unknown responses strict. Only this known native
  # runtime outage may be independent of an unchanged, validated Web ingress.
  echo '::warning::Existing Bots runtime is unavailable; ingress configuration is unchanged. Continuing the Web release without claiming Bots health.'
else
  echo "::error::The Bots ingress failed its public health check (HTTP $public_status)." >&2
  exit 1
fi
