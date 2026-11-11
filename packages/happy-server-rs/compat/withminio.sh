#!/bin/bash
# Usage: withminio.sh <command...>
# Starts a throwaway MinIO on 127.0.0.1:$MINIO_PORT (binary: $MINIO_BIN, default
# <repo>/.context/minio/minio) with fresh buckets happy-ts and happy-rs (public
# read), runs the command, stops it.
source "$(dirname "$0")/env.sh"
MINIO_BIN="${MINIO_BIN:-$ROOT/.context/minio/minio}"
export MINIO_PORT="${MINIO_PORT:-9187}"
rm -rf "$WORK/minio-data" && mkdir -p "$WORK/minio-data"
MINIO_ROOT_USER=compatadmin MINIO_ROOT_PASSWORD=compatsecret "$MINIO_BIN" server "$WORK/minio-data" \
    --address "127.0.0.1:$MINIO_PORT" --console-address "127.0.0.1:$((MINIO_PORT + 1))" --quiet > "$WORK/minio.log" 2>&1 &
MINIO=$!
trap 'kill $MINIO; wait $MINIO 2>/dev/null' EXIT
for i in $(seq 1 60); do curl -sf -o /dev/null "http://127.0.0.1:$MINIO_PORT/minio/health/live" && break; sleep 0.3; done
node "$COMPAT/minio-init.mjs" || exit 1
"$@"
