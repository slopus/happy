#!/usr/bin/env bash
set -euo pipefail
package_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$package_dir"
adb reverse tcp:18081 tcp:18081
adb reverse tcp:18443 tcp:18443
# Release APK embeds JS; no Metro server or public networking is required at runtime.
adb install -r example/android/app/build/outputs/apk/release/app-release.apk
adb shell am start -n engineering.happy.tailcat.e2e/.MainActivity
node scripts/wait-result.cjs