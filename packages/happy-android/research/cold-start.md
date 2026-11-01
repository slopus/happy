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
    The bench build has no Firebase client. Until the second pass a store
    build paid about 3 ms more for `FirebaseInitProvider`; no build has it now.
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
  path by hand. Done in the second pass, below.
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

## Second pass: lazy start (2026-10-31, from main at 7f6a279ea)

Steve asked for as much as possible to start lazily, aiming for about
100 ms to the first frame with home's rows on release code. Each change
below was measured on its own build, in 15-run sets. Sets of the same
build vary by about ±4 ms, so the before and after at the end are
interleaved: each build installed in turn, two rounds, 30 starts each.

### What Firebase does here, and when it starts now

Firebase is only FCM: the device's push token (exchanged for an Expo token
and registered with happy-server) and `HappyMessagingService`, which shows
the data messages Expo relays. Before, `FirebaseInitProvider` initialised
FirebaseApp in bindApplication on every cold start of a build with a
Firebase client, about 3 ms on release code and 8 ms debuggable. The
manifest now removes it, and `push/FirebaseStart.kt` starts Firebase
(idempotent, synchronized, the same generated resources) where push
needs it:

- push registration, which now waits for the start to end
  (`LocalAfterStart`: fully drawn and one frame more) and asks on
  Dispatchers.IO; Settings' push rows ask on IO too;
- `HappyMessagingService.onCreate`, before `super.onCreate()`, so a push
  or a token refresh (`onNewToken`) that starts a killed process finds
  Firebase running.

`FirebaseInstanceIdReceiver`, the GMS broadcast that wakes the process,
doesn't touch FirebaseApp before the service starts. In firebase-messaging
25.0.1's bytecode it builds an `FcmBroadcastProcessor`, which only binds or
starts the messaging service (`ServiceStarter`, `WithinAppServiceConnection`,
`WakeLockHolder`: no FirebaseApp references). The first reads are
`MessagingAnalytics`, called from the service's `handleIntent`. The other
Firebase components in the merged manifest start nothing by themselves:
`ComponentDiscoveryService` is only metadata (registrars for messaging,
installations, common and datatransport) read by `initializeApp`;
datatransport's `TransportBackendDiscovery`, `JobInfoSchedulerService` and
alarm receiver run only when something is logged. There is no ML Kit
provider (the QR scanner uses ZXing).

Verified on the Fold with a real push to a killed dev process (`am kill`
from the background, so not stopped, as a swipe-away leaves it). The dev
install's open account is an agent connection, which registers no push
token, and Expo has no FCM credentials for `com.slopus.happy.dev`
(`InvalidCredentials`). So the push was sent through Happy's push server
(push.cluster-fluster.com, native FCM, the same data-only layout as Expo's),
to the install's cached FCM token, and the test device was unregistered
afterwards. Logcat: the process started for `FirebaseInstanceIdReceiver`
at 53.891, FirebaseApp initialised at 53.967 (nothing else can start it
now), and the notification was posted on `messages` at 53.978, shown
heads-up.

### Changes and what each bought (bench, first frame, ms)

| Change | Sets of 15 | Notes |
|---|---|---|
| Before (main at 7f6a279ea) | 117, 118, 118 | |
| FirebaseInitProvider removed | 122, 118, 118 | bench has no Firebase client, so nothing to gain there; dev and store builds gain the provider's 8 or 3 ms |
| Glass blurs from the window's second frame (`FirstFrame`) | 107, 114, 108, 111 | the blur's offscreen layers were 6.8 ms of the first frame's RenderThread (`flush layers`, three image allocations); the first frame draws the bar's opaque tint, the next one blurs |
| The graph shown at attach (`MainActivity.onAttachedToWindow`) | 106, 108 | the graph was built by 41 ms, but the message that told the main thread ran after the first traversal, which composed an empty window, had its draw cancelled by the hold, and drew home a traversal later. Now the first traversal composes and draws home |
| ProfileInstaller's initializer removed (profile written 5 s after the start), PaywallHost composed after the start | 112, 106 | 0.4 ms of bindApplication; inside the noise |

Interleaved, 30 starts each, before and after on the same afternoon:

| Build | First frame before | First frame after | Fully drawn before | Fully drawn after |
|---|---|---|---|---|
| bench (release code) | 111 | **105** | 111 | **105** (rows in the first frame) |
| dev, verified | 273 | **259** | 522 | **511** |

Tried and taken out:

- **Starting the GPU driver from `Application.onCreate`** (a
  `HardwareRenderer` given a 1×1 `ImageReader` surface). The main thread
  waited 4 ms for the RenderThread to attach, and Vulkan then started only
  1.7 ms sooner than the system's own preload. A net loss.

Checked and left alone:

- **The other initializers.** `ProcessLifecycleInitializer` must be eager
  (lifecycle-process throws when started lazily) and RevenueCat observes
  the process lifecycle. `EmojiCompatInitializer` costs 0.14 ms; its font
  already loads after the first frame, and text composed before
  EmojiCompat is configured would never get its emoji. OkHttp's
  `PlatformInitializer` (0.24 ms) gives OkHttp the context it reads the
  public suffix list with.
- **Fonts.** The system font (in the zygote's cache) and the icon font
  (0.07 ms) load during measure; nothing to gain.
- **Avatars.** Placeholders are stills unless Animated Avatars is on; their
  pictures decode on Dispatchers.Default after the first frame.
- **Runtime class verification.** One trace, right after an install, had
  5 ms of `VerifyClass` on the main thread for R8-merged classes; later
  traces of the same install had none.

### Where the 105 ms goes now (bench)

| Step | ms |
|---|---|
| The system, from the launch to the fork | about 28 |
| Zygote, bindApplication (dex and app image 4.6, initializers 0.6) | about 18 |
| Activity create, start, resume | 7 |
| addView waiting for the RenderThread's Vulkan instance and device (the system's preload) | 12–15 |
| First traversal on the main thread: composition 1, measure 9 (text 3.6), relayout 3, record 1 | 15 |
| First frame on the RenderThread: image allocations, cached pipelines, text atlas | 12 |

What's left is mostly fixed cost: the system's launch, the Vulkan driver
(the main thread can't proceed until it's loaded, and the app can't start
it sooner), and the GPU's first frame. Getting to 100 would mean less in
home's first frame itself: fewer rows measured, or cheaper text.

## Guards

- `ColdStartTest` (Robolectric) pins what runs before the first frame: the
  two content providers and the three androidx.startup initializers in
  the merged manifest, and that FirebaseInitProvider is not one of them.
  `FirebaseStartTest` pins that the messaging service starts Firebase when
  nothing has, and that starting it again (from any thread) keeps one app. It checks that `HappyApplication.onCreate` builds
  nothing, and that `AppGraph.warmHome()` only starts the open home's disk
  read (`DiskThread.strict`) and that the rows come in without home
  composed.
- `StartupBenchmark` (macrobenchmark, on a device) measures
  timeToInitialDisplay and timeToFullDisplay, cold, with and without the
  Baseline Profile.
- The offline-first guards are unchanged: `DiskThread`,
  `OfflineFirstJourneyTest`.
