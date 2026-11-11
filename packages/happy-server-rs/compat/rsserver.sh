#!/bin/bash
# Usage: rsserver.sh <db> <port>  -- the Rust server in the foreground
# (PROFILE=release for an optimized build).
source "$(dirname "$0")/env.sh"
export DATABASE_URL="postgresql://postgres@127.0.0.1:$PGPORT/$1?connection_limit=20"
export HANDY_MASTER_SECRET="${HANDY_MASTER_SECRET:-test-master-secret}"
export PORT="$2" METRICS_ENABLED=false NODE_ENV=production DATA_DIR="$WORK/data-$1"
export HAPPY_RS_EXPO_PUSH_URL="$COMPAT_MOCK/exp.host/--/api/v2/push/send"
export HAPPY_RS_ELEVENLABS_API="$COMPAT_MOCK/api.elevenlabs.io/v1/convai"
export HAPPY_RS_GITHUB_OAUTH_BASE="$COMPAT_MOCK/github.com" HAPPY_RS_GITHUB_API_BASE="$COMPAT_MOCK/api.github.com"
exec "$ROOT/packages/happy-server-rs/target/${PROFILE:-debug}/happy-server-rs" serve
