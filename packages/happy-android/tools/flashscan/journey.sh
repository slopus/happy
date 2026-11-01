#!/usr/bin/env bash
# The flash check: a cold start, then opening a chat, recorded and scanned
# for bright frames (scan.py). Run it with the app and the phone in the
# themes to check, e.g. the app Dark on a light phone.
#
#   ANDROID_SERIAL=<device> tools/flashscan/journey.sh <package> <out-dir> ["<chat title>"]
#
# DISPLAY_ID records one display of a foldable (screenrecord --display-id).
# Each step prints scan.py's JSON; maxBright is the largest share of bright
# pixels in a frame. The first frames are the launcher, so read the
# brightest frames' times against the PNGs written for frames over the
# threshold.
set -euo pipefail
package=$1 out=$2 chat=${3:-}
adb=${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}
here=$(cd "$(dirname "$0")" && pwd)

tap() {
  "$adb" shell uiautomator dump /sdcard/flashscan-ui.xml >/dev/null
  "$adb" shell cat /sdcard/flashscan-ui.xml | python3 -c '
import re, sys
for m in re.finditer(r"<node [^>]*>", sys.stdin.read()):
    n = m.group(0)
    if re.search(r" text=\"%s\"" % re.escape(sys.argv[1]), n):
        x1, y1, x2, y2 = map(int, re.findall(r"\d+", re.search(r"bounds=\"([^\"]*)\"", n).group(1)))
        print((x1 + x2) // 2, (y1 + y2) // 2)
        break' "$1"
}

"$adb" shell input keyevent HOME
"$adb" shell am force-stop "$package"
sleep 1
activity=$("$adb" shell cmd package resolve-activity --brief "$package" | tail -1 | tr -d '\r')
"$here/record.sh" "$out" cold-start 6 am start -W -n "$activity"
if [ -n "$chat" ]; then
  sleep 2
  at=$(tap "$chat")
  [ -z "$at" ] && { echo "no row titled \"$chat\"" >&2; exit 2; }
  "$here/record.sh" "$out" open-chat 4 input tap $at
fi
