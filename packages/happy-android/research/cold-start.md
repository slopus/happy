# Cold start

Steve's measure: time to the first meaningful frame, meaning home's bar over
its kept rows, or its loader while the disk is read. It is not the time
until everything has synced. Measured on the Galaxy Z Fold7 (inner screen,
Android 17), on 2026-10-31, from main at dc8c8b770.

## How it is measured

- **First frame:** `am start -W -S`'s TotalTime, which ends at the first drawn
  frame. Fifteen cold starts (force-stop first), median.
- **Fully drawn:** home with its rows. `ReportDrawnWhen` on both homes
  (relay: the list read; agent connection: the catalog read, or its
  offline state) and `ReportDrawn` on the first screen report it, and the
  `Fully drawn` line in logcat gives the time.
- **Two builds.**
  - **dev** (`com.slopus.happy.dev`) is what Steve runs. It is debuggable,
    so ART runs it with the JIT and without ahead-of-time code.
  - **bench** (`com.slopus.happy.bench`) is the release code after R8,
    debug-signed and installed beside the others, never shipped. It has no
    account of its own: `src/bench`'s `BenchFixture` seeds one agent
    connection with a kept home of Steve's size (18 bots, 46 tasks,
    24 projects, 53 workspaces, 167 agents, about 350 KB). Seed it with
    `am broadcast -f 0x20 -n com.slopus.happy.bench/com.slopus.happy.bench.BenchFixture -a com.slopus.happy.bench.SEED`.
    The bench build has no Firebase client, so it skips Firebase's
    `FirebaseInitProvider`. A store build pays about 3 ms more for it.
- **Traces:** Perfetto with am, wm, view, gfx, dalvik, res, binder and sched,
  plus the app's own sections (`diagnostics/traced`): `AppGraph`,
  `warmHome`, `PushServices` and `AgentSession.readCache`. While measuring,
  each step of the graph had one too. The account registry and its Keystore
  credentials were the largest at 12 ms of the graph's 55 (debuggable), and
  the whole graph is off the critical path.
- **Macrobenchmark:** `benchmark/`'s `StartupBenchmark` (cold, 15
  iterations, with and without the Baseline Profile; it reports
  timeToInitialDisplay and timeToFullDisplay).
  `ANDROID_SERIAL=<device> ./gradlew :benchmark:connectedBenchmarkBenchAndroidTest`.
  Its COLD mode also drops the GPU's pipeline cache, so its first frame
  spends about 140 ms compiling Vulkan pipelines (`CreateGraphicsPipeline`)
  that an ordinary cold start finds cached. That makes its numbers about
  300 ms where `am start` reads about 120 ms. Compare its runs with each
  other, not with `am start`.

## Where the time went (before)

### dev, as installed by `adb install`

The system doesn't compile a debuggable app on install. `dumpsys package
dexopt` says `run-from-apk`, so every cold start opens the APK's 29 dex
files itself. Times are ms from the launch intent:

| Step | ms |
|---|---|
| Fork from zygote, debuggable runtime set up | 0–27 |
| **bindApplication: dex extracted (inflated) and verified** | **27–345, about 315** |
| Firebase 8, androidx.startup (emoji, lifecycle, OkHttp, profileinstaller) 12 | 20 |
| Activity create and resume | 30 |
| Graph on its own thread (registry, Keystore credentials, preferences) | in parallel, done before the first traversal |
| Compose: first composition and measure of HappyApp and home (interpreted) | 210 |
| Draw | 15 |
| First frame | **688 median** |
| Home's rows (the 350 KB catalog decoded on IO, in the interpreter) | +150 |
| Fully drawn | **839 median** |

The first frame was never held for the graph. It is built in 55 ms on
its own thread and is done while the main thread is still in
`Compose:initializeView`. The hold (`MainActivity.holdFirstFrame`) costs
nothing, so it stays.

### bench (release code, speed-profile)

| Step | ms |
|---|---|
| Fork from zygote | 0–28 |
| bindApplication (dex mapped from the odex, androidx.startup 2) | 22 |
| Activity create and resume (Vulkan instance created in parallel) | 31 |
| Graph | 6–10, in parallel |
| Compose first composition and measure | 30 |
| Draw (RenderThread) | 15 |
| First frame | **116 median** |
| Fully drawn | 119 median: rows one frame late in some starts |

The release build was already fast. Home's read of the kept catalog
(18 ms) started only once home had composed, so the rows sometimes came a
frame after the bar.

## What changed

1. **The debug APK stores its dex instead of deflating it**
   (`packaging.dex.useLegacyPackaging = false` for debuggable variants). ART
   maps a stored dex straight from the APK, so a `run-from-apk` start no
   longer inflates about 60 MB of dex first. The APK grows from 88 to
   140 MB, which makes `adb install` a few seconds slower. Release and
   preview are unchanged; Play splits dex itself.
2. **Home's data is read while the window composes.** The graph's thread,
   once the graph is built, calls `AppGraph.warmHome()`. That makes the
   open agent connection's `AgentSession`, whose init reads the kept
   catalog on IO, or the open Happy account's `HomeServices`, whose list
   reads SQLite. Home used to ask for the same once composed, 100–150 ms
   later on dev. On bench the catalog is in before the first composition,
   so the rows are in the first frame.
3. **Baseline and startup profiles** (`benchmark/`'s
   `BaselineProfileGenerator`: cold start to home, a chat and back, against
   the bench fixture) in `app/src/main/generated/baselineProfiles`, merged
   into every variant, with `profileinstaller` for sideloaded installs and
   `dexLayoutOptimization`. Regenerate after large UI changes:
   `ANDROID_SERIAL=<device> ./gradlew :app:generateBaselineProfile`.
4. **Fully drawn is reported** (`ReportDrawnWhen` on both homes,
   `ReportDrawn` on the first screen), so `am start`, Play vitals and the
   macrobenchmark see when home has its rows.
5. **Trace sections** for the graph, the home warm-up and the catalog read.

Considered and not done:

- **Not holding the first frame for the graph.** The hold costs nothing:
  the graph is done before the first traversal in both builds. A frame
  without the graph would be an empty window, and HappyApp needs the
  graph's theme, language, open account and settings for anything more.
- **Deferring Firebase.** Its provider costs about 3 ms (8 ms debuggable).
  `HappyMessagingService` can start the process for a push without the
  activity, so removing the provider means initializing Firebase on that
  path by hand.
- **RevenueCat, voice, push:** none of them starts with the process.
  RevenueCat configures on its first account, the voice SDK only in
  `connect()`, and push's services on the graph's thread.
- **R8** was already on for release and preview.
- **Shaders and blur:** placeholder avatars on home are stills unless
  Animated Avatars is on (a setting that defaults to off). The glass bar's
  RenderEffect costs no measurable time in the first frame (`DrawFrames`
  15 ms in all on bench, mostly the first upload of text and pictures).

## After

Medians of 15 cold starts on the Fold:

| Build | First frame before | First frame after | Fully drawn before | Fully drawn after |
|---|---|---|---|---|
| dev, as `adb install` leaves it (`run-from-apk`) | 688 | **516** | 839 | **639** |
| dev, after `cmd package compile -m verify` | 285 | 302 | — | 558 |
| bench (release code), speed-profile | 116 | 118 | 119 | **118** (rows in the first frame) |

The macrobenchmark (bench, pipeline cache dropped, 15 iterations) puts the
main thread's part of the first frame at 149 ms with the Baseline Profile
against 191 ms without. Its timeToInitialDisplay is 298 against 328, and its
timeToFullDisplay equals timeToInitialDisplay in both.

## What's left

- **The dev build's catalog decode.** In the debuggable runtime, reading
  the 350 KB kept catalog takes 250–360 ms, so dev shows home's loader for
  that long (fully drawn 558 against a 302 ms first frame once verified).
  Release decodes it in 13–18 ms. Keeping home's derived rows (`AgentFeed`)
  in a small file of their own, read first, would bring dev's rows into
  the first frame. That would mean a second kept file to keep consistent
  with the catalog.
- **dev without `verify`** still verifies its dex on every start (about
  135 ms) until the system compiles it in the background. After
  `adb install` of the dev build, run
  `adb shell cmd package compile -m verify -f com.slopus.happy.dev`
  (AGENTS.md).
- **Compose's first composition** of HappyApp is about 30 ms in release.
  `NavHost` registers every route's destination on the first frame.

## Guards

- `ColdStartTest` (Robolectric) pins what runs before the first frame: the
  three content providers and the four androidx.startup initializers in
  the merged manifest. It checks that `HappyApplication.onCreate` builds
  nothing, and that `AppGraph.warmHome()` only starts the open home's disk
  read (`DiskThread.strict`) and that the rows come in without home
  composed.
- `StartupBenchmark` (macrobenchmark, on a device) measures
  timeToInitialDisplay and timeToFullDisplay, cold, with and without the
  Baseline Profile.
- The offline-first guards are unchanged: `DiskThread`,
  `OfflineFirstJourneyTest`.
