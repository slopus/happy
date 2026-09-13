#!/usr/bin/env bash
set -euo pipefail
package_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$package_dir"
simulator_id="${TAILCAT_SIMULATOR_ID:?Set TAILCAT_SIMULATOR_ID}"
xcrun simctl bootstatus "$simulator_id" -b
xcrun simctl install "$simulator_id" build/ios/Build/Products/Release-iphonesimulator/TailcatE2E.app
xcrun simctl launch "$simulator_id" engineering.happy.tailcat.e2e
if ! node scripts/wait-result.cjs; then
  xcrun simctl spawn "$simulator_id" log show --last 3m --style compact --predicate 'process == "TailcatE2E"' | node scripts/redact-logs.cjs
  exit 1
fi