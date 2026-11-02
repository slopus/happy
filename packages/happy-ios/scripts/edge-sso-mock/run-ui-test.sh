#!/bin/bash
# On a Mac: the edge SSO mock, a simulator named "edge-sso-ios", erased
# first (Keychain included; KEEP_SIMULATOR=1 skips that) and trusting only
# its CA, ServerSignInUITests (ad-hoc signed: an unsigned simulator app
# can't use its Keychain), then the screenshots out of the result bundle.
# Output goes to $OUT (default: a new directory under $TMPDIR).
set -uo pipefail
MOCK_DIR=$(cd "$(dirname "$0")" && pwd); SRC=$(cd "$MOCK_DIR/../.." && pwd)
OUT=${OUT:-${TMPDIR:-/tmp}/edge-sso-e2e-$(date +%s)}; DD=${DERIVED_DATA:-${TMPDIR:-/tmp}/edge-sso-dd}
mkdir -p "$OUT"
"$MOCK_DIR/certs.sh"
pkill -f "$MOCK_DIR/server.mjs" 2>/dev/null; sleep 1
node "$MOCK_DIR/server.mjs" > "$OUT/mock.log" 2>&1 &
MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
sleep 1
devices() { xcrun simctl list devices --json; }
SIM=$(devices | python3 -c '
import json,sys
for rt,ds in json.load(sys.stdin)["devices"].items():
    for d in ds:
        if d["name"]=="edge-sso-ios" and d["isAvailable"]: print(d["udid"]); raise SystemExit')
if [ -z "$SIM" ]; then
  RT=$(devices | python3 -c '
import json,sys
for rt,ds in json.load(sys.stdin)["devices"].items():
    if any(d["name"]=="iPhone 17 Pro" and d["isAvailable"] for d in ds): print(rt); raise SystemExit')
  SIM=$(xcrun simctl create edge-sso-ios "iPhone 17 Pro" "$RT")
fi
echo "simulator $SIM"
if [ "${KEEP_SIMULATOR:-}" != 1 ]; then
  xcrun simctl shutdown "$SIM" 2>/dev/null
  xcrun simctl erase "$SIM"
fi
xcrun simctl boot "$SIM" 2>/dev/null; xcrun simctl bootstatus "$SIM" -b > /dev/null
xcrun simctl keychain "$SIM" add-root-cert "$MOCK_DIR/ca.crt"
xcrun simctl uninstall "$SIM" com.slopus.happy.dev 2>/dev/null
cd "$SRC" && xcodegen generate --spec project.yml > "$OUT/xcodegen.log" 2>&1
xcodebuild test -project Happy.xcodeproj -scheme HappyDirectUI -configuration Debug -destination "platform=iOS Simulator,id=$SIM" \
  -derivedDataPath "$DD" CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER= CODE_SIGNING_ALLOWED=YES \
  -only-testing:HappyDirectUITests/ServerSignInUITests -resultBundlePath "$OUT/result.xcresult" > "$OUT/test.log" 2>&1
STATUS=$?
grep -E "error:|Test Case.*(passed|failed|skipped)|TEST (SUCCEEDED|FAILED)" "$OUT/test.log" | tail -15
mkdir -p "$OUT/shots"
xcrun xcresulttool export attachments --path "$OUT/result.xcresult" --output-path "$OUT/shots" > /dev/null 2>&1 || echo "attachment export failed"
echo "results in $OUT"
exit $STATUS
