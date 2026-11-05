# Native store captures

These scripts capture the five v8 store screens and the 18-second hero on the real native
apps. Inputs:

- the iOS app on an iPhone, an iPad and an iPhone Duo simulator
- the Android app on a Pixel 9 emulator, rendered at two tablet sizes
- the fictional story in `../fixtures`

The pictures they produce become `../inputs/<device>/`, and `../render.mjs` composes them
into the store cards.

All commands in this README run from this folder (`scripts/mobile-captures/native`).

Nothing here signs, publishes or touches a real account. Every run follows the same
rules:

- It works on a copy of the repository.
- It writes to a results folder that must not exist yet.
- It undoes its device changes in a `finally` block.

```
native/
  README.md
  audit-video.py              frame-timing audit for raw and composed videos
  lib/story_fixture.py        reads ../fixtures/StoryData.swift; date shift, wide chart, Android UTC
  lib/capture_common.py       copy guard, new-only folders, hashes, capture.json
  ios/
    StoryHarness.swift        fictional in-memory computer behind `-screen story`
    StoryV8CaptureUITests.swift   stills and hero for iPhone, iPad and Duo
    install.py                fixture into a copy (+ ChatHarness route, xcodegen)
    capture.py                one target on one simulator
    remote.sh                 sync / install / capture / fetch / status over ssh
  android/
    StoryV8DeviceShots.kt     stills and voice on production Compose screens
    StoryV8HeroMotion.kt      hero on the normal Choreographer (no test clock)
    patches/account-menu-wrap.patch   product change already on main (7e32e0945)
    install.py                assets + tests into a copy (tablet class generated)
    emulator.py               owned RAM clone of a prepared AVD: start / stop
    demo_mode.py              SystemUI demo mode (09:41, one Wi-Fi icon, full battery)
    capture.py                stills | tablets | hero on one emulator
    remote.sh                 sync / install / build / capture / fetch / status over ssh
```

## The fixture

`../fixtures/StoryData.swift` is the single source of the story:

- every wire record as JSON
- the Feed and Home pictures
- the two people's photos
- the inline retention chart

It is the standard neutral fixture, sha256 `2ad3251de5e29fa8e68bd31d02ef09acc733c2d3b78ab290c594fb268396773f`.
Steve's photo is the bundled abstract placeholder `avatar-placeholder-058` (see
`../fixtures/AVATAR-PLACEHOLDERS-NOTICE.md` and its MIT licence). Both platforms read the
same file:

- iOS embeds it as `Harness/StoryData.swift`.
- Android's `install.py` writes each record to `androidTest/assets/marketing/<name>.json`.
  It adds the explicit `orderKey`/`userVisible` fields Android reads, and moves the wall
  times Android shows (page, voicepage, feed, usage resets) to the same wall time in UTC.

With `--shift-to none`, both installers reproduce the captured bytes exactly. Checked:

- iOS StoryData gives `2ad3251d…`.
- Android gives all 19 JSON assets, `chart.html`, the photos and icons, and the generated
  tablet class, each byte-identical to the approved capture tree.

Install options:

- `--shift-to today` (the default) moves every time by whole days. The time moves in Los
  Angeles wall-clock time, so DST is handled. The Feed's rows stay "Today", messages stay
  at 9:30 AM, and usage still "resets Thu 9:00 AM".
- `--wide-chart` adds one CSS rule to the chart page: at 560 pt and wider it stays 300 pt
  wide. This gives sha `be4edc50…`, which is used only for the approved **Duo inner 05**.
  On that short wide screen the answer, chart, legend and caption then fit one screen.
  Phones are unaffected, and every other set is captured without it.

## Reference environment

The approved v8 sets were captured on the following. Other versions should work, but
check the pictures.

| | |
| --- | --- |
| Mac | Xcode 27.2 (27B52), xcodegen, ffmpeg; locale `en_US`, time zone `America/Los_Angeles` |
| iPhone | iPhone 17 Pro Max, iOS 26.3 simulator: 1320×2868 |
| iPad | iPad Pro 13-inch (M5), iOS 26.3 simulator, landscape: 2752×2064 |
| iPhone Duo | iPhone Duo, iOS 27.1 simulator: inner 2853×2007 (display 3), outer 1398×2034 (display 1) |
| Duo fold | [hinge](https://github.com/artemnovichkov/hinge), built from source (commit 06cb7202) |
| Android VM | Linux, Android SDK at `$ANDROID_HOME` (default `/opt/android-sdk`), JDK from `/etc/profile.d/development-tools.sh` |
| Android device | API 35 Pixel 9 AVD (1080×2424, 420 dpi), emulator `-gpu swangle -feature -Vulkan`, 2 GB guest |

**Capture state on iOS:**

- Light appearance (`simctl ui … appearance light`).
- The simulator inherits the Mac's locale (en_US) and time zone. The fixture's wall times
  assume Los Angeles.
- Status bar: 9:41, Wi-Fi 3 bars, cellular active with 4 bars and no operator name, and
  battery charged at 100. Without the cellular flags the bar shows "no service" dots.
- `--status-time` takes an ISO date too, which also sets the iPad's date.

**Capture state on Android:**

- Light theme (the tests force `ThemePreference.Light`).
- The device's en-US locale.
- The fixture process sets its default time zone to UTC.
- SystemUI demo mode, entered only through `sysui_tuner_demo_on` (see `demo_mode.py`): 09:41,
  one validated Wi-Fi icon, mobile hidden, battery 100 and unplugged, no notifications.

## iOS

The scripts run on a Mac with Xcode, through `ios/remote.sh`. The scripts' defaults hold
no host names or paths; set the environment for your machine:

```sh
export MAC=user@mac-host            # ssh destination
export REMOTE_ROOT=happy-captures   # on the Mac, under its home
# export SSHPASS=...                # optional: authenticate through sshpass -e

ios/remote.sh sync                  # copy this checkout (no .git) to $REMOTE_ROOT/repo, writes SOURCE_COMMIT
ios/remote.sh install               # fixture, test and ChatHarness route; xcodegen
ios/remote.sh capture iphone       --sim <iPhone 17 Pro Max UDID> --out iphone-1
ios/remote.sh capture ipad         --sim <iPad Pro 13" UDID>      --out ipad-1
ios/remote.sh capture duo-outer    --sim <iPhone Duo UDID> --hinge path/to/hinge --out duo-outer-1
ios/remote.sh capture iphone-video --sim <iPhone 17 Pro Max UDID> --out iphone-hero-1
ios/remote.sh capture ipad-video   --sim <iPad Pro 13" UDID>      --out ipad-hero-1
ios/remote.sh install --wide-chart  # only for the Duo inner set
ios/remote.sh capture duo-inner    --sim <iPhone Duo UDID> --hinge path/to/hinge --out duo-inner-1
ios/remote.sh fetch iphone-1 ./captures/iphone-1   # checks SHA256SUMS
ios/remote.sh status
```

What a capture does:

- Duo targets fold the device first. The inner screen is opened (`LCD-1`) and the outer is
  closed (`LCD`).
- Each target runs one UI test, `StoryV8CaptureUITests/testStills` or `testHeroVideo`,
  with `CODE_SIGNING_ALLOWED=NO`.
- DerivedData lives in the copy (`.capture-derived`), so the first build is slow.
- The Duo's screens are not `XCUIScreen.main`. The test prints `V8_CAPTURE <name>` and holds
  the state for 3 s, while the host takes `simctl io --display=N screenshot`.
- The hero is one continuous `simctl io recordVideo --codec=h264`, running from
  `STORY_VIDEO_BEGIN` to `STORY_VIDEO_END`. For the Duo it records that display.
- `finally`:
  - stops the recorder
  - stops xcodebuild
  - clears the status bar override
  - shuts the simulator down if this run booted it (`--keep-booted` leaves it)

**Results** (`$REMOTE_ROOT/results/<out>`):

- `named/`: every state as captured: `01-home 02-feed 03-new-picker 03-model-accounts
  04-servers 05-voice-callfirst` plus `05-voice-up1..3`. The `up` frames are taken after
  slow drags upward, for short screens.
- `inputs/`: the five renderer inputs, named as `../inputs/<device>/` expects:

  | `inputs/` | from `named/` |
  | --- | --- |
  | `01-home` | `01-home` |
  | `02-feed` | `02-feed` |
  | `03-model-accounts` | `03-model-accounts` |
  | `04-servers` | `04-servers` |
  | `05-voice` | `05-voice-callfirst` |

  The approved sets all use `05-voice-callfirst`, including Duo inner with `--wide-chart`.
  XCUIScreen delivers an iPad in landscape as its portrait framebuffer, so `inputs/` turns
  it upright with ffmpeg `transpose=2`. That is lossless (PNG to PNG), and the result is
  byte-identical to the approved `../inputs/ipad`.
- `hero-raw.mp4`, `hero-audit.json`
- `xcodebuild.log`, `test.xcresult`, `capture.json` (command, env, PIDs, posture, exit),
  `SHA256SUMS`

## Android

Build and capture on the Android VM through `android/remote.sh`. The app is built on the
VM, never locally.

```sh
export HOST=user@android-vm
export REMOTE_ROOT=happy-captures
export APP_ID=com.slopus.happy.screenshots   # private debug ID, installed beside other builds

android/remote.sh sync
android/remote.sh install                    # assets, tests; account-menu patch if the copy predates it
android/remote.sh build                      # :app:assembleDebug :app:assembleDebugAndroidTest, --max-workers=1
android/remote.sh capture stills  android-1  <prepared Pixel 9 AVD>
android/remote.sh capture tablets tablets-1  <prepared Pixel 9 AVD>
android/remote.sh capture hero    hero-1     <prepared Pixel 9 AVD>   # 540x1212 at 210 dpi
android/remote.sh fetch android-1 ./captures/android-1
android/remote.sh status
```

Each `capture` follows the same sequence:

1. **Start.** `emulator.py start` clones the prepared AVD into `/dev/shm`, so the source AVD
   is never written. It refuses a serial that is in use, or a host with less than 7 GB of
   available memory. It also refuses clone folders that already exist. The state file is
   written before anything is copied. If the copy or launch fails, start removes only the
   folders it made. Then it waits for boot.
2. **Capture.** `capture.py` installs both APKs, locks rotation, changes the display size
   and density, then configures demo mode twice. Demo mode must come after the display
   change, because that recreates SystemUI. It then runs one fixture test and pulls its
   PNGs through `run-as`:
   - **stills**: `StoryV8DeviceShots#stills`, Pixel 9, 1080×2424, 420 dpi.
   - **tablets**: `StoryV8TabletShots#stills`, the phone class inside production
     `ProvideWindowLayout`, at two sizes:
     - `android-7`: 1200×1920, 320 dpi, 600×960 dp
     - `android-10`: 1600×2560, 320 dpi, 800×1280 dp
     These are native renders, not scaled phone shots. Neither reaches the 840 dp split
     layout.
   - **hero**: `StoryV8HeroMotion#hero`, a continuous `screenrecord` at 8 Mbps.
     - Native 540×1212 at 210 dpi kept the approved take under 100 ms per frame.
     - At 1080×2424 the emulator renders at about 29 fps with hitches.
     - The take also records `hero-timing.tsv` and `events.json`: each planned change and
       how late it landed.
3. **Cleanup.** In `capture.py`'s `finally`, display size and density are reset, demo mode
   is left, the app is stopped and the on-device recording removed. Then the remote shell's
   `trap` runs `emulator.py stop`. It kills only the recorded PID, confirms it ended, and
   removes only the clone's two RAM folders.

Results go in `named/` (including `03-model-list`), `inputs/android/`,
`inputs/android-7/` and `inputs/android-10/`, alongside:

- `instrumentation*.log`
- `systemui-audit-*.json` and `systemui-check-*.png`
- `capture.json` (APK hashes, PIDs, timings)
- `SHA256SUMS`

## Video timing audit

```sh
python3 audit-video.py hero-raw.mp4 --motion [--max-gap-ms 50] [--json report.json]
```

The audit reports:

- the stream: codec, profile, level, size, rotation, bit rate, audio
- frames, span and mean rate
- median and largest frame gaps, and the count of gaps over 34, 50, 67 and 100 ms
- timestamps that go backwards

Simulator and `screenrecord` files are variable-rate: a long gap over a still screen is
not a stall. `--motion` decodes a 120×90 grey copy and reports two things:

- frames identical to the one before while their neighbours move (stalls)
- gaps over `--max-gap-ms` that end in motion (held frames)

The exit status is 1 for either kind of failure. iOS captures run the audit with a 50 ms
limit and Android heroes with 100 ms; both write it as `hero-audit.json`. Run it on
composed videos too. Store files should be constant 30 fps with no duplicates during
motion. For the App Store, also check H.264 level ≤ 4.0, 10–12 Mbps, AAC stereo 48 kHz
(silent is fine), 15–30 s, and app-only full-bleed content (guideline 2.3.4).

Approved takes, for reference:

| Take | Result |
| --- | --- |
| iPhone hero | 1076 frames, max gap 23 ms, pass |
| iPad hero | max gap 150 ms over static frames; one 122 ms hold ending in motion at 3.46 s, flagged at 50 ms. Review that moment in the exported video; nothing repairs it |
| Android hero | 758 frames, 34.4 fps, max gap 82 ms, none over 100 ms |

## Safety notes

- **Copies only.** Installers refuse a Git checkout unless `--allow-checkout` is passed.
  The sources in this folder are committed on purpose. What the installers write into
  `packages/` (the harness and StoryData copies, the ChatHarness route, test files, Android
  assets, the account-menu patch) belongs to the capture copy and must never be committed.
- **New folders only.** Results folders are created fresh and never reused, so earlier
  results stay.
- **One owned device per run.** Only the simulator or emulator a run booted is shut down.
- **No signing material.** iOS builds use `CODE_SIGNING_ALLOWED=NO`. Android builds are
  debug builds under a private application ID. Nothing here uploads or publishes.
- **Fictional content.** The story is fictional: no inference, voice, billing or account
  traffic. Kirill's photo is his existing fixture picture; Steve's is the neutral
  placeholder.
