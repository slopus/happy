#!/usr/bin/env bash
# Build and capture the Android story on the Android VM from any machine with ssh and rsync.
#
#   HOST=user@host android/remote.sh sync                  copy this checkout (no .git)
#   HOST=user@host android/remote.sh install [args]        android/install.py on the copy
#   HOST=user@host android/remote.sh build                 fixture app + test APKs (Gradle)
#   HOST=user@host android/remote.sh capture MODE NAME SOURCE_AVD [capture.py args]
#        MODE stills | tablets | hero; boots an owned RAM clone, captures into results/NAME,
#        and always stops the clone and removes its RAM folders afterwards
#   HOST=user@host android/remote.sh fetch NAME LOCAL_DIR  copy results/NAME back
#   HOST=user@host android/remote.sh status                emulators, capture processes, memory
#
# Environment:
#   HOST         ssh destination (required)
#   REMOTE_ROOT  folder on the VM (default: happy-captures, relative to the remote home)
#   COPY_NAME    repository copy under REMOTE_ROOT (default: repo)
#   REPO         checkout to sync (default: this script's repository)
#   APP_ID       fixture application ID (default: com.slopus.happy.screenshots), installed beside others
#   PORT         emulator console port (default: 5850, serial emulator-PORT)
#   SSHPASS, SSH_OPTS as in ios/remote.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
: "${HOST:?set HOST=user@host}"
REMOTE_ROOT=${REMOTE_ROOT:-happy-captures}
COPY_NAME=${COPY_NAME:-repo}
REPO=${REPO:-$(cd "$here/../../../.." && pwd)}
APP_ID=${APP_ID:-com.slopus.happy.screenshots}
PORT=${PORT:-5850}
copy="$REMOTE_ROOT/$COPY_NAME"
native="$copy/scripts/mobile-captures/native"
apks="$copy/packages/happy-android/app/build/outputs/apk"

ssh_cmd=(ssh ${SSH_OPTS:-})
[ -n "${SSHPASS:-}" ] && ssh_cmd=(sshpass -e "${ssh_cmd[@]}")
remote() { "${ssh_cmd[@]}" "$HOST" "$*"; }
quote() { [ $# -eq 0 ] || printf '%q ' "$@"; }

case "${1:-}" in
  sync)
    commit=$(git -C "$REPO" rev-parse HEAD)
    dirty=$(git -C "$REPO" status --porcelain | head -c1)
    remote "mkdir -p $(quote "$copy") $(quote "$REMOTE_ROOT/results")"
    rsync -a --delete -e "$(quote "${ssh_cmd[@]}")" \
      --exclude .git --exclude node_modules --exclude .context --exclude build --exclude .gradle \
      --exclude local.properties --exclude keystore.properties --filter 'P SOURCE_COMMIT' \
      "$REPO/" "$HOST:$copy/"
    remote "printf '%s%s\n' $(quote "$commit") $(quote "${dirty:+ (with uncommitted changes)}") > $(quote "$copy/SOURCE_COMMIT")"
    echo "synced $commit${dirty:+ + local changes} to $HOST:$copy"
    ;;
  install)
    shift
    remote "python3 $(quote "$native/android/install.py") --repo $(quote "$copy") $(quote "$@")"
    ;;
  build)
    # A private debug build: never a release, never signed for a store.
    remote "set -e; [ -f /etc/profile.d/development-tools.sh ] && . /etc/profile.d/development-tools.sh
      cd $(quote "$copy/packages/happy-android")
      HAPPY_BUILD_COMMIT_SHA=\$(cut -d' ' -f1 ../../SOURCE_COMMIT) ./gradlew --max-workers=1 \
        -Phappy.applicationId=$(quote "$APP_ID") :app:assembleDebug :app:assembleDebugAndroidTest
      sha256sum app/build/outputs/apk/debug/app-debug.apk app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
    ;;
  capture)
    shift
    mode=$1 name=$2 avd=$3; shift 3
    state="$REMOTE_ROOT/results/$name.emulator.json"
    stop="[ -f $(quote "$state") ] && python3 $(quote "$native/android/emulator.py") stop --state $(quote "$state")"
    # The owned clone is stopped however the capture ends; capture.py resets the display itself.
    remote "set -e; trap $(quote "$stop") EXIT
      mkdir -p $(quote "$REMOTE_ROOT/results") $(quote "$REMOTE_ROOT/apks-$name")
      cp $(quote "$apks/debug/app-debug.apk") $(quote "$apks/androidTest/debug/app-debug-androidTest.apk") $(quote "$REMOTE_ROOT/apks-$name/")
      python3 $(quote "$native/android/emulator.py") start --state $(quote "$state") --port $PORT --name happy-capture-$PORT --source-avd $(quote "$avd")
      python3 -u $(quote "$native/android/capture.py") $(quote "$mode") --serial emulator-$PORT --package $(quote "$APP_ID") \
        --apk-dir $(quote "$REMOTE_ROOT/apks-$name") --out $(quote "$REMOTE_ROOT/results/$name") $(quote "$@")"
    ;;
  fetch)
    name=$2 dest=$3
    mkdir -p "$dest"
    rsync -a -e "$(quote "${ssh_cmd[@]}")" "$HOST:$REMOTE_ROOT/results/$name/" "$dest/"
    if (cd "$dest" && sha256sum -c --quiet SHA256SUMS); then echo "fetched $name, hashes match"; else echo "hash mismatch in $dest" >&2; exit 1; fi
    ;;
  status)
    remote "\${ANDROID_HOME:-/opt/android-sdk}/platform-tools/adb devices; pgrep -fl 'emulator|capture.py|screenrecord' || true; free -g | head -2"
    ;;
  *)
    sed -n '2,22p' "$0"; exit 2 ;;
esac
