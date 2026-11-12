#!/bin/bash
# Usage: rsserver.sh <db> <port>  -- the Rust server in the foreground
# (PROFILE=release for an optimized build, RS_BIN=<path> for another binary).
source "$(dirname "$0")/env.sh"
export DATABASE_URL="postgresql://postgres@127.0.0.1:$PGPORT/$1?connection_limit=20"
export HANDY_MASTER_SECRET="${HANDY_MASTER_SECRET:-test-master-secret}"
[ -n "$S3_BUCKET" ] && export S3_BUCKET="$S3_BUCKET-rs" S3_PUBLIC_URL="$S3_PUBLIC_URL-rs"
export PORT="$2" METRICS_ENABLED="${METRICS_ENABLED:-false}" METRICS_PORT=$(( $2 + 6000 )) NODE_ENV=production DATA_DIR="$WORK/data-$1"
export HAPPY_RS_EXPO_PUSH_URL="$COMPAT_MOCK/exp.host/--/api/v2/push/send"
export HAPPY_RS_ELEVENLABS_API="$COMPAT_MOCK/api.elevenlabs.io/v1/convai"
export HAPPY_RS_GITHUB_OAUTH_BASE="$COMPAT_MOCK/github.com" HAPPY_RS_GITHUB_API_BASE="$COMPAT_MOCK/api.github.com"
cd "$WORK" && exec "${RS_BIN:-$ROOT/packages/happy-server-rs/target/${PROFILE:-debug}/happy-server-rs}" serve
