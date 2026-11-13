#!/bin/bash
# Runs on the Android build node: installs the debug build on our emulator and
# screenshots Gen UI render documents with GenUiGymActivity.
#
#   shoot.sh [fixture-name ...]          bundled fixtures (all by default) -> shots/
#   shoot.sh --dir <dir-of-json> [out]   every *.json in <dir>, read at launch
#                                        (no rebuild) -> out (default shots-dir/)
# NOINSTALL=1 skips installing the APK.
set -e
. /etc/profile.d/development-tools.sh
export ANDROID_SERIAL=${ANDROID_SERIAL:-emulator-5680}
# Your own folder on the node, holding repo/ (the checkout) and the shot output.
ROOT=${GENUI_ROOT:-$HOME/genui}
PKG=com.slopus.happy.dev
APK=$ROOT/repo/packages/happy-android/app/build/outputs/apk/debug/app-debug.apk
adb shell settings put secure immersive_mode_confirmations confirmed
[ -z "$NOINSTALL" ] && adb install -r -t $APK > /dev/null

# The gym draws the whole block, however tall, to files/genui-shot.png (genui.capture).
shoot() { # <name> <extras...>
  local name=$1; shift
  adb shell am force-stop $PKG
  adb shell am start -W -n $PKG/com.slopus.happy.ui.genui.GenUiGymActivity --ez genui.capture true "$@" > /dev/null
  for i in $(seq 1 20); do
    sleep 1
    adb shell run-as $PKG ls files/genui-shot.png > /dev/null 2>&1 && break
  done
  adb exec-out run-as $PKG cat files/genui-shot.png > $OUT/$name.png
  echo "shot $name $(stat -c %s $OUT/$name.png) bytes"
}

if [ "$1" = "--dir" ]; then
  DIR=$2; OUT=${3:-$ROOT/shots-dir}
  mkdir -p $OUT
  adb shell run-as $PKG mkdir -p files/genui
  for f in "$DIR"/*.json; do
    name=$(basename "$f" .json); name=${name%.render}
    adb exec-in "run-as $PKG sh -c 'cat > files/genui/$name.json'" < "$f"
    shoot "$name" -e genui.path "genui/$name.json"
  done
else
  OUT=$ROOT/shots
  mkdir -p $OUT
  FIXTURES="$@"
  [ -z "$FIXTURES" ] && FIXTURES=$(ls $ROOT/repo/packages/happy-android/app/src/debug/assets/genui/fixtures | sed 's/\.json$//')
  for f in $FIXTURES; do shoot "$f" -e genui.fixture "$f"; done
fi
