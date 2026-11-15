#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $(id -u) == 0 ]]; then
  install -d -m 750 -o node -g node /data
  exec gosu node "$0"
fi

# Set DATABASE_MIGRATION_URL to the owner and DATABASE_URL to a runtime login to
# enforce row-level security; with one URL the app runs as the owner and warns.
# Migrate, then start over without the owner login: unset alone would leave it in this
# shell's original environment, which any process running as node can read from /proc.
if [[ "${1:-}" != serve ]]; then
  pnpm --filter @rakazo/api db:deploy
  exec env -u DATABASE_MIGRATION_URL bash "$0" serve
fi

export RAILWAY_ENVIRONMENT_ID
RAILWAY_ENVIRONMENT_ID=$(node infra/railway/sandbox-environment.mjs)
pnpm --filter @rakazo/api exec node dist/cli/bootstrap-owner.js
unset OWNER_PASSWORD
# Personal template: registration is operator configuration, never an app-account permission.
export SIGNUPS_ENABLED=false

# All processes share one volume; a failed process restarts the whole service.
trap 'kill $(jobs -pr) 2>/dev/null || true; wait || true' EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
# The API is reached only through the web preview proxy on loopback. Railway's edge names the
# client in X-Real-IP, which that proxy passes on unchanged.
# Server installs encrypt content at rest unless the operator sets CONTENT_ENCRYPTION=off.
export CONTENT_ENCRYPTION="${CONTENT_ENCRYPTION:-on}"
export TRUSTED_PROXIES="${TRUSTED_PROXIES:-127.0.0.1}"
export CLIENT_IP_HEADER="${CLIENT_IP_HEADER:-x-real-ip}"
pnpm --filter @rakazo/api start &
pnpm --filter @rakazo/worker start &
(
  node --input-type=module -e '
  for (let attempt = 0; attempt < 60; attempt++) {
    const ready = await fetch("http://127.0.0.1:3100/ready", { signal: AbortSignal.timeout(2000) }).then(r => r.ok).catch(() => false);
    if (ready) process.exit(0);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("API did not become ready");
'
  exec env -u RAILWAY_API_TOKEN -u DATABASE_URL -u ENCRYPTION_KEY -u ENCRYPTION_MASTER_KEYS -u OBJECT_STORAGE_SECRET_ACCESS_KEY -u BETTER_AUTH_SECRET \
    pnpm --filter @rakazo/web preview --host 0.0.0.0 --port 5173
) &
wait -n
exit 1
