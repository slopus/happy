#!/bin/bash
# On a Mac: the cloud email mock on every interface, then
# CloudEmailSignInUITests in the chat harness on a phone or a booted
# simulator, its sign-ins sent to the mock at http://$MOCK_HOST:8790
# (default: en0's address, which a phone must reach; 127.0.0.1 for a
# simulator), then the screenshots out of the result bundle. DEVICE is the
# phone's or simulator's UDID (default: the first connected iPhone); TEAM
# signs for it. Output goes to $OUT (default: a new directory under
# $TMPDIR).
set -uo pipefail
MOCK_DIR=$(cd "$(dirname "$0")" && pwd); SRC=$(cd "$MOCK_DIR/../.." && pwd)
OUT=${OUT:-${TMPDIR:-/tmp}/cloud-email-$(date +%s)}; DD=${DERIVED_DATA:-${TMPDIR:-/tmp}/cloud-email-dd}
PORT=${PORT:-8790}; MOCK_HOST=${MOCK_HOST:-$(ipconfig getifaddr en0)}
DEVICE=${DEVICE:-$(xcrun devicectl list devices 2>/dev/null | awk '/physical/ && /iPhone/ { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9A-F]{8}-[0-9A-F]{16}$/) { print $i; exit } }')}
mkdir -p "$OUT"
pkill -f "$MOCK_DIR/server.mjs" 2>/dev/null; sleep 1
PORT=$PORT node "$MOCK_DIR/server.mjs" > "$OUT/mock.log" 2>&1 &
MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
sleep 1
echo "device $DEVICE, mock http://$MOCK_HOST:$PORT"
cd "$SRC" && xcodegen generate --spec project.yml > "$OUT/xcodegen.log" 2>&1
TEST_RUNNER_HAPPY_CLOUD_EMAIL_MOCK="http://$MOCK_HOST:$PORT" \
xcodebuild test -project Happy.xcodeproj -scheme HappyChatUI -configuration Debug -destination "id=$DEVICE" -derivedDataPath "$DD" \
  -allowProvisioningUpdates ${TEAM:+DEVELOPMENT_TEAM=$TEAM} \
  -only-testing:HappyChatUITests/CloudEmailSignInUITests -resultBundlePath "$OUT/result.xcresult" > "$OUT/test.log" 2>&1
STATUS=$?
grep -E "error:|Test Case.*(passed|failed|skipped)|TEST (SUCCEEDED|FAILED)" "$OUT/test.log" | tail -15
mkdir -p "$OUT/shots"
xcrun xcresulttool export attachments --path "$OUT/result.xcresult" --output-path "$OUT/shots" > /dev/null 2>&1 || echo "attachment export failed"
echo "results in $OUT"
exit $STATUS
