#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../go"
export GOMAXPROCS="${GOMAXPROCS:-4}"
go test -p 4 -race -count=1 -timeout=120s ./...