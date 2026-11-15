#!/usr/bin/env bash
# Run every infra/compose/*.smoke.sh (bash-only; no Docker/pnpm).
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
shopt -s nullglob
scripts=("$root"/*.smoke.sh)
if ((${#scripts[@]} == 0)); then
  echo "No compose installer smoke scripts found." >&2
  exit 1
fi
for script in "${scripts[@]}"; do
  echo "==> ${script}"
  bash "$script"
done
