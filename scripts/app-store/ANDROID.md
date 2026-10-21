# Local Android screenshot setup

This is one-time native-build and dedicated-device setup. Reuse the same owned
AVDs afterward; start the mobile gym and isolated Agent/scenario separately.
The capture runner repeats an explicit navigation plan once those prerequisites
are ready. This is not yet a single command that builds, provisions, seeds,
captures, and cleans up everything.

Everything here is local development. Do not publish an OTA, submit a build,
upload to a store, or change production app code. Generated Android projects,
APKs, device data, account-bearing debug bundles, raw captures, and intermediate
exports remain ignored. Use actual Android captures; never reuse iPhone/iPad
screens or Apple device-frame artwork for these outputs.

## Prerequisites and explicit paths

The verified host was Apple Silicon macOS with Node26.7.0, pnpm10.11.0,
JDK17.0.18, Gradle9.0.0, emulator37.1.11, and platform-tools37.0.1. The build uses
SDK platform36, build-tools36.0.0, NDK27.1.12297006, and CMake3.22.1. The devices
use the installed ARM64 Google Play API36.1 image, revision4:
`system-images;android-36.1;google_apis_playstore;arm64-v8a`.

Install missing prerequisites deliberately from their official sources. This
recipe does not update an existing SDK or accept licenses automatically. The
ARM64 image is for Apple Silicon; do not assume this exact recipe works on an
Intel host. Java25 was also installed on the verified host but was not used.

Set these variables to your own absolute paths in each terminal that needs
them. Start from the Happy mobile repository root, not the desktop repository:

```sh
CAPTURE_REPO="$PWD"
CAPTURE_SDK=/absolute/path/to/Android/sdk
CAPTURE_JAVA=/absolute/path/to/jdk-17/Contents/Home
CAPTURE_NODE_BIN=/absolute/path/to/node/bin
CAPTURE_ROOT="$CAPTURE_REPO/.context/android-devices"
CAPTURE_ADB="$CAPTURE_SDK/platform-tools/adb"
CAPTURE_AVDMANAGER="$CAPTURE_SDK/cmdline-tools/latest/bin/avdmanager"
CAPTURE_PATH="$CAPTURE_NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin"
CAPTURE_ADB_PORT=5038
```

Verify the paths and versions first. Confirm `.context/` and
`packages/happy-app/android/` are ignored. Use a clean, current checkout for
capture provenance. Neither setup nor capture authorizes Git pushes.

## Build the development APK

Install repository dependencies with `pnpm install --frozen-lockfile`. From
`packages/happy-app`, generate Android only:

```sh
env -i PATH="$CAPTURE_PATH" JAVA_HOME="$CAPTURE_JAVA" \
 ANDROID_HOME="$CAPTURE_SDK" APP_ENV=development \
 EXPO_NO_DOTENV=1 EXPO_NO_TELEMETRY=1 CI=1 \
 node ../../node_modules/expo/bin/cli prebuild --platform android --no-install
```

Do **not** invoke the package's `prebuild` script: that script removes both
Android and iOS directories. Do not add `--clean`. The verified normal CLI
generated only the ignored Android project and left tracked app files unchanged;
inspect your diff and stop if generation changes tracked app code.

From `packages/happy-app/android`, build the debug APK:

```sh
env -i PATH="$CAPTURE_PATH" JAVA_HOME="$CAPTURE_JAVA" \
 ANDROID_HOME="$CAPTURE_SDK" ANDROID_USER_HOME="$CAPTURE_ROOT/home" \
 GRADLE_USER_HOME="$CAPTURE_REPO/.context/android-build/gradle" \
 APP_ENV=development NODE_ENV=development EXPO_NO_DOTENV=1 \
 EXPO_NO_TELEMETRY=1 CI=1 \
 ./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a \
 '-Dorg.gradle.jvmargs=-Xmx6g -XX:MaxMetaspaceSize=1g' \
 --no-daemon --max-workers=4 --console=plain
```

The generated wrapper pins Gradle9.0.0; it may download that distribution on
first use. The verified build invoked an already installed copy of that same
distribution, with mutable Gradle state in the ignored path above. The default
2GB Java heap exhausted during the first build; the command-scoped6GB allowance
completed successfully without editing Gradle or app source. Some dependencies
compile additional native ABIs internally; the resulting APK was ARM64-only.

Verify successful exit and inspect the artifact before installation:

```sh
CAPTURE_APK="$CAPTURE_REPO/packages/happy-app/android/app/build/outputs/apk/debug/app-debug.apk"
"$CAPTURE_SDK/build-tools/36.0.0/aapt" dump badging "$CAPTURE_APK"
shasum -a 256 "$CAPTURE_APK"
```

Expected package: `com.slopus.happy.dev`, label `Happy (dev)`, minSDK24,
targetSDK36, native code `arm64-v8a`. Record the current hash and source commit;
do not assume another build has the first capture's hash. This is a development
client, not a distributable release build.

## Create owned AVDs once

Use a private, ignored AVD directory instead of the developer's default AVDs.
Never select an arbitrary connected device, use a physical device, copy a user's
AVD data, or overwrite an existing AVD. These names belong to the screenshot
workflow, not to a device-discovery heuristic.

```sh
mkdir -p "$CAPTURE_ROOT/avd" "$CAPTURE_ROOT/home"
env -i PATH="$CAPTURE_PATH" JAVA_HOME="$CAPTURE_JAVA" \
 ANDROID_HOME="$CAPTURE_SDK" ANDROID_USER_HOME="$CAPTURE_ROOT/home" \
 ANDROID_AVD_HOME="$CAPTURE_ROOT/avd" \
 "$CAPTURE_AVDMANAGER" create avd --name happy-capture-phone-xq29 \
 --package 'system-images;android-36.1;google_apis_playstore;arm64-v8a' \
 --device pixel --path "$CAPTURE_ROOT/avd/happy-capture-phone-xq29.avd"
```

Repeat this creation command with the following explicit names/profiles. Do not
use `--force`; reuse an existing owned device after verifying its identity.

| Target              | AVD name                      | Creation profile | Serial          | Native width×height | Logical dpi |
| ------------------- | ----------------------------- | ---------------- | --------------- | ------------------- | ----------- |
| `android-phone`     | `happy-capture-phone-xq29`    | `pixel`          | `emulator-5580` | 1080×1920           | 420         |
| `android-tablet-7`  | `happy-capture-tablet7-xq29`  | `Nexus 7 2013`   | `emulator-5582` | 1920×1080           | 288         |
| `android-tablet-10` | `happy-capture-tablet10-xq29` | `Nexus 10`       | `emulator-5584` | 1920×1080           | 216         |

Before the tablets' first boot, edit only their new `config.ini` files under
`$CAPTURE_ROOT/avd/<name>.avd/`: set `hw.lcd.width=1920`,
`hw.lcd.height=1080`, `hw.initialOrientation=landscape`, and
`hw.lcd.density=288` or `216` respectively. Keep `hw.lcd.depth=32`.
The phone's Pixel profile already supplies the listed dimensions and density.

These are custom tablet capture profiles based on official definitions, not
claims of stock Nexus resolution. Their shortest logical widths are600dp and
800dp, so the app receives genuinely different tablet layout widths. Android's
logical density selects layout/assets; it is not a physical diagonal
measurement. Do not resize screenshots or use runtime `wm size`/`wm density`
overrides to pretend a phone capture came from a tablet.

## Start the private adb server and devices

Check that the selected ports are free. A port collision is a reason to inspect
and choose explicit unused ports, not to kill the listener. The capture runner
requires a private adb port other than5037.

In its own owned foreground terminal/process, start adb:

```sh
env -i PATH="$CAPTURE_PATH" ANDROID_USER_HOME="$CAPTURE_ROOT/home" \
 "$CAPTURE_ADB" -s emulator-5580 -L "tcp:$CAPTURE_ADB_PORT" server nodaemon
```

Do not pass `-a` (all interfaces). This version accepts `-L tcp:5038` for its
local listener, but rejects a hostname in that listener argument. Do not use
`adb start-server` as a fallback or connect to the developer's default server.

Start each emulator as another owned foreground process, changing only the
explicit `-avd` and even-numbered `-port` for that device:

```sh
env -i PATH="$CAPTURE_PATH" ANDROID_HOME="$CAPTURE_SDK" \
 ANDROID_USER_HOME="$CAPTURE_ROOT/home" ANDROID_AVD_HOME="$CAPTURE_ROOT/avd" \
 ANDROID_ADB_SERVER_PORT="$CAPTURE_ADB_PORT" \
 ADB_SERVER_SOCKET="tcp:127.0.0.1:$CAPTURE_ADB_PORT" \
 "$CAPTURE_SDK/emulator/emulator" -avd happy-capture-phone-xq29 -port 5580 \
 -no-window -no-audio -no-boot-anim -no-snapshot-load -no-snapshot-save \
 -camera-back none -camera-front none -gpu host \
 -feature -Vulkan,-WiFiPacketStream,-Uwb -cores 2
```

The radio switches reflect an observed host-tool issue: emulator37.1.11 stalled
while initializing its Netsim Wi-Fi packet streamer. A native stack sample
showed QEMU blocked in `NetsimWifiForwarder::init`, with guest CPU threads waiting
for initialization. Selecting the emulator's older virtual Wi-Fi backend let
all three existing API36.1 images boot. This did not modify Happy networking,
disable app security, replace the SDK, or simulate app UI. Record these emulator
settings with capture provenance; do not describe the original failure as an
Android app crash.

Every adb client command must include `-H 127.0.0.1`, the private port, and
explicit serial. With only `-P`, adb may automatically start a replacement
server if the owned server disappears, using ambient authentication state.
The explicit host makes the client fail instead. This does not change the
separate owned foreground server launch with `-L ... server nodaemon` above.
Before any mutation, verify the expected AVD and boot state:

```sh
CAPTURE_SERIAL=emulator-5580
"$CAPTURE_ADB" -H 127.0.0.1 -P "$CAPTURE_ADB_PORT" -s "$CAPTURE_SERIAL" emu avd name
"$CAPTURE_ADB" -H 127.0.0.1 -P "$CAPTURE_ADB_PORT" -s "$CAPTURE_SERIAL" shell getprop sys.boot_completed
"$CAPTURE_ADB" -H 127.0.0.1 -P "$CAPTURE_ADB_PORT" -s "$CAPTURE_SERIAL" shell wm size
"$CAPTURE_ADB" -H 127.0.0.1 -P "$CAPTURE_ADB_PORT" -s "$CAPTURE_SERIAL" shell wm density
```

Require the exact owned name, boot value1, and listed native dimensions/density.
Verify actual PNG orientation too; the first capture checked1080×1920 phone
and1920×1080 tablets directly from their screenshot headers.

## Connect the separately staged gym

Start the mobile gym through its [documented owned lifecycle](../../packages/happy-mobile-gym/README.md),
with explicit local server/Metro ports, and wait for `ready`. Stage the isolated
Agent and sample scenario separately using [the screenshot guide](README.md).
Do not use production authentication. Reusing a run preserves its account and
database; record the current capture commit, not just its older creation commit.

For each verified serial, create the exact gym port mappings. These examples
use server64950 and Metro64951; change both sides together if your run differs:

```sh
"$CAPTURE_ADB" -H 127.0.0.1 -P "$CAPTURE_ADB_PORT" -s "$CAPTURE_SERIAL" reverse --no-rebind tcp:64950 tcp:64950
"$CAPTURE_ADB" -H 127.0.0.1 -P "$CAPTURE_ADB_PORT" -s "$CAPTURE_SERIAL" reverse --no-rebind tcp:64951 tcp:64951
```

On reuse, inspect existing mappings with the same explicit host/port/serial and
`reverse --list`; reuse identical
mappings and stop on unexpected ones instead of overwriting them. Reversal
lets Android use the gym's exact `127.0.0.1` URLs. Do not change the harness to
accept a LAN address or Android's host alias.

Install the verified APK on each new owned device, then open its local client:

```sh
"$CAPTURE_ADB" -H 127.0.0.1 -P "$CAPTURE_ADB_PORT" -s "$CAPTURE_SERIAL" install "$CAPTURE_APK"
"$CAPTURE_ADB" -H 127.0.0.1 -P "$CAPTURE_ADB_PORT" -s "$CAPTURE_SERIAL" shell am start \
 -a android.intent.action.VIEW \
 -d 'exp+happy://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A64951' \
 com.slopus.happy.dev
```

An unchanged installed development client does not need reinstallation for
every JS capture. Updating a rebuilt APK is a deliberate action on the same
verified owned device; do not uninstall or clear its account data as routine
setup. The URL above carries no credentials. The debug Metro bundle does carry
the private gym account token/secret, so never track, upload, or distribute it.

## Appearance and repeat capture

On each verified device, use normal OS controls for dark mode and status-bar
demo presentation. This changes status decoration, not product state:

```sh
"$CAPTURE_ADB" -H 127.0.0.1 -P "$CAPTURE_ADB_PORT" -s "$CAPTURE_SERIAL" shell cmd uimode night yes
"$CAPTURE_ADB" -H 127.0.0.1 -P "$CAPTURE_ADB_PORT" -s "$CAPTURE_SERIAL" shell settings put global sysui_demo_allowed 1
"$CAPTURE_ADB" -H 127.0.0.1 -P "$CAPTURE_ADB_PORT" -s "$CAPTURE_SERIAL" shell am broadcast -a com.android.systemui.demo -e command enter
"$CAPTURE_ADB" -H 127.0.0.1 -P "$CAPTURE_ADB_PORT" -s "$CAPTURE_SERIAL" shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0941
"$CAPTURE_ADB" -H 127.0.0.1 -P "$CAPTURE_ADB_PORT" -s "$CAPTURE_SERIAL" shell am broadcast -a com.android.systemui.demo -e command battery -e plugged false -e level 100
"$CAPTURE_ADB" -H 127.0.0.1 -P "$CAPTURE_ADB_PORT" -s "$CAPTURE_SERIAL" shell am broadcast -a com.android.systemui.demo -e command network -e wifi show -e level 4 -e fully true -e mobile hide
"$CAPTURE_ADB" -H 127.0.0.1 -P "$CAPTURE_ADB_PORT" -s "$CAPTURE_SERIAL" shell am broadcast -a com.android.systemui.demo -e command notifications -e visible false
```

Inspect screenshots to confirm the OS honored these commands. A broadcast's
successful exit alone is not proof of the final pixels. No app UI tap is part
of this device-preparation step.

From the repository root, use `scripts/app-store/android-capture.mjs` with the
explicit adb executable, private port, serial, AVD, and target. For example:

```sh
node scripts/app-store/android-capture.mjs inspect \
 --adb "$CAPTURE_ADB" --adb-port "$CAPTURE_ADB_PORT" \
 --serial emulator-5580 --avd happy-capture-phone-xq29 --target android-phone
```

The runner validates emulator identity and native geometry; it does not build,
install, reset devices, start adb/the gym, or seed sessions. Follow the main
screenshot guide for each explicit scene plan, fresh capture/output directories,
composition, inspection, and fixture disclosures. Keep fictional participants
and scripted responses labeled honestly; their rendering does not prove real
multi-account team authentication or vendor inference. Phone marketing
compositions and native-only tablet exports are separate outputs.

## Cleanup and reuse

Keep the live process handles/foreground sessions created for this run. Stop
the owned scenario/Agent and gym through their normal controller `stop()` or
foreground Ctrl-C; stop each owned emulator and the foreground private adb
process through its own live session handle/Ctrl-C. Stop private adb after its
emulators. An automation owner should request graceful termination and use its
process/session API to finish cleanup if needed, then verify its listeners ended.

Never use `adb kill-server`, stored PID/PGID kills, broad process-name matching,
or deletion of AVDs/userdata to clean up. Do not stop a process just because it
occupies a desired port. Preserve the ignored devices, database, account, and
captures for reuse; no wipe, snapshot reset, or user-device action is required.
