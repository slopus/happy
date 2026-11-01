#!/usr/bin/env bash
# Records the screen while something happens, then scans it for bright frames.
#
#   tools/flashscan/record.sh <out-dir> <name> <seconds> <adb shell command...>
#
# ANDROID_SERIAL picks the device; ADB the adb binary (default: the SDK's).
# The command runs a second after the recording starts (screenrecord drops
# its first frames). Prints scan.py's JSON; frames over the threshold are
# written beside the recording.
set -euo pipefail
out=$1 name=$2 seconds=$3
shift 3
adb=${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$out"
remote=/sdcard/flashscan-$name.mp4
"$adb" shell rm -f "$remote"
"$adb" shell screenrecord --bit-rate 16000000 --time-limit "$seconds" ${DISPLAY_ID:+--display-id "$DISPLAY_ID"} "$remote" &
recorder=$!
sleep 1
"$adb" shell "$@" >/dev/null
wait $recorder || true
sleep 0.5
"$adb" pull "$remote" "$out/$name.mp4" >/dev/null
"$adb" shell rm -f "$remote"
python3 "$here/scan.py" "$out/$name.mp4" --frames "$out/frames" --json ${THRESHOLD:+--threshold "$THRESHOLD"} || true
