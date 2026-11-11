#!/bin/bash
# Usage: rsserver.sh <db> <port>  -- the Rust server in the foreground
# (PROFILE=release for an optimized build).
source "$(dirname "$0")/env.sh"
export DATABASE_URL="postgresql://postgres@127.0.0.1:$PGPORT/$1?connection_limit=20"
export HANDY_MASTER_SECRET="${HANDY_MASTER_SECRET:-test-master-secret}"
export PORT="$2" METRICS_ENABLED=false NODE_ENV=production DATA_DIR="$WORK/data-$1"
exec "$ROOT/packages/happy-server-rs/target/${PROFILE:-debug}/happy-server-rs" serve
