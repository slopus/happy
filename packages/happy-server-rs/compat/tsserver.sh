#!/bin/bash
# Usage: tsserver.sh <db> <port>  -- the TS server in the foreground.
source "$(dirname "$0")/env.sh"
cd "$ROOT/packages/happy-server"
export DATABASE_URL="postgresql://postgres@127.0.0.1:$PGPORT/$1?connection_limit=20"
export HANDY_MASTER_SECRET="${HANDY_MASTER_SECRET:-test-master-secret}"
[ -n "$S3_BUCKET" ] && export S3_BUCKET="$S3_BUCKET-ts" S3_PUBLIC_URL="$S3_PUBLIC_URL-ts"
export PORT="$2" METRICS_ENABLED="${METRICS_ENABLED:-false}" METRICS_PORT=$(( $2 + 6000 )) NODE_ENV=production DATA_DIR="$WORK/data-$1"
[ -z "$COMPAT_NO_PRELOAD" ] && export NODE_OPTIONS="--import $COMPAT/fetch-mock.mjs"
exec "$ROOT/node_modules/.bin/tsx" ./sources/main.ts
