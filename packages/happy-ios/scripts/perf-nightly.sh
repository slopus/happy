#!/bin/bash
# The hosted UIKit perf plan (`hosted-perf-tests.txt`), enforced: run on a
# Mac (the Mac Mini, nightly) against origin/main at its budgets, unscaled.
# CI only reports these, because GitHub's virtual Macs miss them at random.
#
#     scripts/perf-nightly.sh [DIR]
#
# PERF_BRANCH runs another branch instead, to try a change to the plan.
# Works in DIR (default ~/happy-perf-nightly): a clone of the repository,
# kept between runs, and one folder per run with the log, the result bundle
# and `summary.txt`. `latest` points at the newest run. Exits non-zero when a
# test misses its budget.
set -uo pipefail
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
ROOT=${1:-$HOME/happy-perf-nightly}
REPO=$ROOT/repo
RUN=$ROOT/$(date -u +%Y-%m-%dT%H%MZ)
mkdir -p "$RUN"
ln -sfn "$RUN" "$ROOT/latest"

if [[ ! -d $REPO/.git ]]; then
  git clone -q https://github.com/slopus/happy.git "$REPO" || exit 1
fi
cd "$REPO" || exit 1
git fetch -q origin "${PERF_BRANCH:-main}" && git checkout -q --detach FETCH_HEAD || exit 1
echo "commit $(git rev-parse HEAD)" > "$RUN/summary.txt"

cd packages/happy-ios || exit 1
xcodegen generate > "$RUN/xcodegen.log" 2>&1 || exit 1
NAME=happy-perf-nightly
SIM=$(xcrun simctl list devices available | grep -m1 "$NAME (" | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
if [[ -z $SIM ]]; then
  SIM=$(xcrun simctl create $NAME com.apple.CoreSimulator.SimDeviceType.iPhone-17 com.apple.CoreSimulator.SimRuntime.iOS-27-0) || exit 1
fi
xcrun simctl boot "$SIM" 2>/dev/null
xcrun simctl bootstatus "$SIM" -b > /dev/null

python3 scripts/hosted-test-shard.py perf > "$RUN/tests.txt" || exit 1
xargs xcodebuild test \
  -project Happy.xcodeproj -scheme HappyUIKitHosted -configuration Debug \
  -destination "platform=iOS Simulator,id=$SIM" \
  -derivedDataPath "$ROOT/DerivedData" \
  -resultBundlePath "$RUN/perf.xcresult" \
  -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO \
  < "$RUN/tests.txt" > "$RUN/xcodebuild.log" 2>&1
STATUS=$?
grep -E "^Test Case .*(passed|failed)|: error: " "$RUN/xcodebuild.log" >> "$RUN/summary.txt"
echo "status $STATUS" >> "$RUN/summary.txt"
exit $STATUS
