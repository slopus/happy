#!/bin/bash
# Usage: tsserver.sh <db> <port>  -- the TS server in the foreground.
source "$(dirname "$0")/env.sh"
cd "$ROOT/packages/happy-server"
export DATABASE_URL="postgresql://postgres@127.0.0.1:$PGPORT/$1?connection_limit=20"
export HANDY_MASTER_SECRET="${HANDY_MASTER_SECRET:-test-master-secret}"
export PORT="$2" METRICS_ENABLED=false NODE_ENV=production DATA_DIR="$WORK/data-$1"
export NODE_OPTIONS="--import $COMPAT/fetch-mock.mjs"
exec "$ROOT/node_modules/.bin/tsx" ./sources/main.ts
