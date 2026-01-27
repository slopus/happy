#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

WORKFLOW_PATH="${ACT_WORKFLOW_PATH:-.github/workflows/tests.yml}"
ARCH="${ACT_ARCH:-linux/amd64}"
LOG_DIR="${ACT_LOG_DIR:-/tmp}"

usage() {
  cat <<'EOF'
Run the GitHub Actions test workflow locally using `act`.

Usage:
  bash scripts/ci/run-act-tests.sh              # run all jobs
  bash scripts/ci/run-act-tests.sh <job>...     # run specific job(s)

Jobs:
  expo-app
  server
  cli
  cli-daemon-e2e

Env overrides:
  ACT_WORKFLOW_PATH   (default: .github/workflows/tests.yml)
  ACT_ARCH            (default: linux/amd64)
  ACT_LOG_DIR         (default: /tmp)
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if ! command -v act >/dev/null 2>&1; then
  echo "Error: \`act\` is not installed or not on PATH." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: \`docker\` is not installed or not on PATH." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Error: Docker does not appear to be running (docker info failed)." >&2
  exit 1
fi

if [[ ! -f "$WORKFLOW_PATH" ]]; then
  echo "Error: workflow not found at \`$WORKFLOW_PATH\`." >&2
  exit 1
fi

mkdir -p "$LOG_DIR"

DEFAULT_JOBS=(expo-app server cli cli-daemon-e2e)
JOBS=("$@")
if [[ ${#JOBS[@]} -eq 0 ]]; then
  JOBS=("${DEFAULT_JOBS[@]}")
fi

RUN_ID="$(date +%Y%m%d-%H%M%S)"

echo "Using workflow: $WORKFLOW_PATH"
echo "Using arch:     $ARCH"
echo "Log dir:        $LOG_DIR"
echo "Jobs:           ${JOBS[*]}"
echo

for job in "${JOBS[@]}"; do
  log_file="$LOG_DIR/act-${job}-${RUN_ID}.log"
  echo "==> Running act job: $job"
  echo "    Log: $log_file"
  echo
  act --container-architecture "$ARCH" -W "$WORKFLOW_PATH" -j "$job" | tee "$log_file"
  echo
done
