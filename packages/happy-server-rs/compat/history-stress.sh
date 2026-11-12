#!/bin/bash
# Usage: withpg.sh [withminio.sh] history-stress.sh [all|stress|crash|throttle]
# Under withminio.sh, pages go to a private bucket (HISTORY_S3_BUCKET=history-rs).
# Build the Rust server first.
source "$(dirname "$0")/env.sh"
[ -n "$MINIO_PORT" ] && { set -a; source "$COMPAT/phase4-s3.env"; set +a; export HISTORY_S3=1; }
WORK="$WORK" node "$COMPAT/history-stress.mjs" "${1:-all}"
