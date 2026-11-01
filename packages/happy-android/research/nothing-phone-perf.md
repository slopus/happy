# Nothing Phone navigation

Work in progress, 2026-10-31. Baseline source: `1f1c38d04`.

**Current decision:** the content-capture opt-out in `1be782b7d` was
reverted by `1f9265c27`. It removed CPU work but did not earn its place as a navigation
performance fix in the controlled release-code comparison. The benchmark
and isolation test remain. The glass task's bilinear prefilter is now
confirmed to save 2–3 ms of GPU time here. The expanded profile cuts
fresh-process Settings tap-to-visible-motion median by 14 ms; warm taps
remain about 79 ms. Home retention and navigation-start latency are the
next isolated changes, not completed fixes.

## Device and method

- Nothing Phone A065, serial `331d7713`, Android 16, 1080 × 2412,
  420 dpi, Adreno 730. The display reported 90 Hz physical/render rate and
  a 90 Hz render cap; its supported modes are 60, 90 and 120 Hz. No system
  settings were changed.
- `com.slopus.happy.bench`: non-debuggable release code with R8, debug
  signed, installed beside the signed-in dev app. The existing fixture
  provides a cached home (18 bots, 46 tasks, 24 projects, 53 workspaces).
  Its backend does not answer: chat and artifacts measure the destination
  shell/offline path, not a populated transcript or artifact catalog.
- Settings: twelve `input tap 965 210` pushes, each followed by system
  Back, with 1 second to settle and `gfxinfo … reset/framestats` for each
  direction separately. Total is `FrameCompleted - IntendedVsync`; UI is
  `SyncQueued - Vsync`. Missed means `FrameCompleted > FrameDeadline`,
  **not** total greater than 11.1 ms (the pipeline can span vsyncs).
- Perfetto: sched, freq, idle, am, wm, gfx, view, dalvik, input and res.
  Raw evidence lives outside git in
  `/Users/steve/Happy/Tasks/task_43/.context/nothing-perf/`.
- `NavigationBenchmark` adds 12-iteration macrobenchmarks with
  `FrameTimingMetric` and a required baseline profile. The macrobenchmark
  records both push and pop, so its percentiles are not directly comparable
  to the direction-separated gfxinfo samples below. Run on one device:

  ```sh
  ANDROID_SERIAL=331d7713 ./gradlew :benchmark:connectedBenchmarkBenchAndroidTest \
    -Pandroid.testInstrumentationRunnerArguments.class=com.slopus.happy.benchmark.NavigationBenchmark
  ```

## Initial baseline

Milliseconds; unmodified bench, ordinary install before the standardized
macrobenchmark compilation step.

| Direction | Frames | Total p50 / p90 / p99 | UI p50 / p90 / p99 | Missed |
|---|---:|---|---|---:|
| Settings push | 502 | 14.12 / 17.11 / 42.49 | 2.40 / 3.99 / 17.02 | 32 (6.4%) |
| Settings → home | 540 | 13.86 / 17.45 / 54.57 | 2.58 / 5.39 / 42.16 | 24 (4.4%) |

The most expensive UI frame among each operation's first eight frames has
median UI/total 13.0/25.3 ms on push and 42.1/51.0 ms on back. This is an
initial-work proxy, not a claim that the very first frame contains all
destination work: input/ripple, composition and drawing can span frames.

The first system trace puts essentially all RenderThread work and 96% of
main-thread running time on CPUs 4–7 (the performance cores). The CPU is
not stuck on little cores. RenderThread draws take roughly 6–7 ms during
the motion. Main-thread destination/recreation work produces the largest
outliers; one back traversal spends 24 ms inside `Record View#draw()`.
More detailed composition attribution is needed before changing the UI.

With the existing baseline profile explicitly installed by Macrobenchmark:

| Push + back, 12 iterations | CPU duration p50 / p90 / p99 | FrameTimeline overrun p99 | Frames past expected deadline |
|---|---|---:|---:|
| Settings | 8.44 / 9.68 / 21.67 | 18.51 | 233/1070 (21.8%) |
| Chat shell | 7.40 / 8.73 / 21.20 | 14.76 | 67/1066 (6.3%) |
| Artifacts shell | 8.08 / 9.13 / 25.23 | 18.07 | 117/1066 (11.0%) |

Here CPU duration includes the UI and RenderThread pipeline; overrun is
Perfetto FrameTimeline's expected deadline. Neither is the gfxinfo UI/total
column above, and the two deadline definitions must not be combined.

### The actual dev app

The existing signed-in dev install, Personal MacBook Pro, same twelve
Settings cycles: push total p50/p90/p99 **18.49/22.25/68.21 ms**, UI
**4.78/7.52/25.44**, 23/509 missed gfxinfo deadlines. Back total
**13.22/21.13/76.91**, UI **3.29/8.93/56.29**, 43/1055 missed. The live
home keeps animating after the pop, so it has more frames than the offline
bench home; compare its tail, not its missed-frame percentage, to bench.

### Content capture

An app-enabled trace exposed `ContentCapture:changeChecker`: 73 calls,
359.8 ms total main-thread work, max 11.6 ms across three push/back cycles.
The manager walks the moving semantics tree (`getAllUncoveredSemanticsNodesToIntObjectMap`,
153 ms) and constructs system capture events (`sendAppearEvents`, 148 ms).
Its checker also calls `view.measureAndLayout()` before diffing the tree.

Confirmed in the exact Compose 1.12.1 source:
`AndroidContentCaptureManager.isEnabled` requires both
`ContentCaptureManager.isEnabled` and a capture session. Its checker and
semantics/layout-change scheduling are guarded by that flag. Accessibility
uses `AndroidComposeViewAccessibilityDelegateCompat`, and autofill has its
own manager. The experimental public capture-only switch was tested in
`HappyApplication.onCreate`, before any Compose window exists.

Trade-off of opting out: private screens would no longer supply text to Android system
intelligence through content capture (including features built on that
capture). This does **not** disable accessibility, the semantics tree,
autofill, screenshots, clipboard or the app's own translations.
`ContentCaptureIsolationTest` checks readable/clickable semantics, username
autofill metadata and view flags, and calls `View.autofill` with an
`AutofillValue` to verify that Android's virtual-view autofill entry point
still changes the field. The test disables capture only for itself and
restores the previous flag afterwards; production retains the default.

The opt-out trace contains **zero** change-checker, appear-event or
uncovered-semantics-tree scans (only a 0.02 ms framework flush remains).
The ordinary-install frame comparison is mixed: push total
15.84/18.16/32.42 ms, 24/503 missed; back 15.17/17.16/60.23,
28/547 missed. Unlike the initial APK this one includes bench-only tracing,
and neither run controlled JIT compilation, so this is not evidence of an
across-the-board frame-time improvement. A paired fully-compiled comparison
and profile-guided measurements follow. The initial CPU saving alone was
not sufficient reason to keep the opt-out, as the next comparison shows.

The full gate passed (`assembleDebug testDebugUnitTest assembleDebugAndroidTest`
and the benchmark build). The coordinating agent explicitly approved landing
this capture-only removal before the Fold slot becomes available. The Fold
no-regression check is therefore **after landing**, not a completed precondition.

#### Controlled compilation: rejected

Same fixture and tracing dependency, twelve cycles each, both APKs compiled
with `cmd package compile -m speed -f com.slopus.happy.bench`:

| Direction | Capture on: total p50 / p90 / p99 | Capture off: total p50 / p90 / p99 | Missed on → off |
|---|---|---|---|
| Settings push | 15.03 / 17.55 / 25.52 | 15.65 / 17.79 / 34.85 | 23/516 → 34/512 |
| Back to home | 14.37 / 16.14 / 42.60 | 15.13 / 20.31 / 47.90 | 27/550 → 27/551 |

The opt-out removes scans outside Choreographer too. Their
`view.measureAndLayout()` can do work before the next frame; removing all
of that scanning is not equivalent to removing all of that layout work.
In the three-cycle traces, total main-thread CPU fell 1762 → 1569 ms, but
the frame tails did not improve. We do not retain it as a performance fix.

The subsequent Fold check (120 Hz, same two fully compiled bench APKs,
twelve cycles each) was essentially neutral, not a reason to retain it:

| Direction | Capture on: total p50 / p90 / p99 | Capture off: total p50 / p90 / p99 | Missed on → off |
|---|---|---|---|
| Settings push | 10.34 / 11.38 / 15.58 | 10.25 / 11.38 / 15.66 | 28/666 → 25/663 |
| Back to home | 10.05 / 11.38 / 16.52 | 10.12 / 11.34 / 17.50 | 29/684 → 29/684 |

The Fold's dev package was not replaced during this check and was restored
to the foreground when the coordinated device slot ended.

The attempted dev `speed-profile` comparison is **not valid**. First,
the debug APK has no `assets/dexopt/baseline.prof`; an explicit profile
broadcast returned 0 and ART reported `verify` after the compile request.
Second, the capture-on run ended on **Search settings**, not home: checking
the package in front does not prove the intended route was exercised.
Those files remain as diagnostic evidence but are excluded from conclusions.
Use the accessibility-driven macrobenchmark or verify destination and home
after every operation, not only the package.

### Follow-up on integrated main

`1f9265c27` also contains the glass phase-one changes (`c458fa14e`) and the
platform-theme fix. Its dev APK was installed with `-r`, compiled with
`verify`, and checked at Personal MacBook Pro home without clearing data.

A subsequent route-checked run caught a failed system Back on the sixth
cycle: 52 frames were recorded, but the destination was still Settings.
The guard stopped before another tap could open Search settings. This is
not a completed twelve-cycle sample. A dedicated 24-cycle reproduction
returned home correctly **24/24** times. The Perfetto ring retains thirteen
Back down/up key pairs, dispatched as `KeyEvent`, not a gesture sequence.
The isolated failure remains unexplained; no speculative navigation fix
was made. `BenchApp.awaitHome()` now also requires the
home-only Settings control, because the chat and agent page repeat the
fixture row's title and that text alone cannot prove a successful pop.

That reproduction trace also attributes a real-account home-return tail.
`back-repro-main.pftrace`, dev pid 7982, frame token 7646230 (slice 175308):
29 ms after Back ACTION_UP, the main frame takes 83.52 ms, with 79.96 ms
actually running on CPU. `AndroidOwner:measureAndLayout` takes 63.00 ms;
the frame contains 22 recompositions totaling 26.86 ms, 22 applyChanges
slices totaling 12.63 ms, and 21 text measures totaling 6.65 ms. These
nested durations must not be added together. Drawing is only 5.50 ms;
two `AsyncImagePainter.onRemembered` slices total 0.37 ms. This points at
home reconstruction/subcomposition/layout, not evidence that avatar image
work or GPU drawing dominates the return tail. The trace lacks process
names, so identify this app by its captured main pid/thread, not `p.name`.

The recovered composition trace identifies a 30.79 ms Settings frame,
18.84 ms recomposition, 15.21 ms AccountSettings composition and a 9.57 ms
class-verification slice. This makes expanded baseline-profile coverage a
candidate worth measuring, not yet a demonstrated improvement.

The integrated gate initially timed out in
`TabletGroupedSidebarTest.groupedByProjectTheSidebarShowsCheckoutsWithCompactRows`.
That test passed in isolation, then the complete gate passed on rerun
(`assembleDebug testDebugUnitTest assembleDebugAndroidTest`
and `:benchmark:assembleBenchmarkBench`).

All four navigation macrobenchmarks then passed twelve iterations on
integrated main with the existing profile:

| Journey | CPU p50 / p90 / p99 (ms) | Overrun p99 (ms) | Positive overrun |
|---|---|---:|---:|
| Settings + back | 8.66 / 9.94 / 24.37 | 22.39 | 72/1065 (6.8%) |
| Chat + back | 7.64 / 8.95 / 20.30 | 18.84 | 72/1065 (6.8%) |
| Artifacts + back | 8.23 / 9.37 / 22.63 | 13.98 | 55/1065 (5.2%) |
| Agent page + back + return home | 6.85 / 8.39 / 26.20 | 17.73 | 86/1608 (5.3%) |

Agent-page setup opens the chat before measurement; its measured block
includes both the agent-page pop and the final chat-to-home cleanup. Do not
compare its frame count directly to the two-transition cases.

Against the initial macrobenchmark, positive overruns improved for Settings
(21.8% → 6.8%) and artifacts (11.0% → 5.2%), while chat was roughly neutral
(6.3% → 6.8%). CPU tails were mixed. Several intervening commits are present,
so this is an integrated-main comparison, not isolated attribution to glass.
The isolated glass comparison keeps current main's caching and layers but
temporarily substitutes the former full-size Gaussian prefilter for the
three bilinear halvings; both APKs use the same profile and full compilation.

### Isolated glass prefilter: confirmed on Nothing

Twelve route-checked pushes and pops each, same `1f9265c27` sources except
the prefilter, same existing profile, both compiled with `speed`. The
Gaussian comparison retained current layer isolation, band caching and
keyboard/shimmer behavior. It only substituted the old sigma-4 full-size
Gaussian and one 8× shrink for the three bilinear halvings. The temporary
source edit was restored after building the comparison APK.

| Direction | Gaussian total p50 / p90 / p99 (ms) | Bilinear total p50 / p90 / p99 (ms) | Missed Gaussian → bilinear |
|---|---|---|---|
| Settings push | 15.32 / 17.86 / 35.21 | 12.41 / 14.03 / 31.86 | 22/509 → 17/517 |
| Back | 14.23 / 15.78 / 41.63 | 11.67 / 13.06 / 40.40 | 20/549 → 19/551 |

The aggregated `gfxinfo` GPU histograms (1 ms buckets, not exact per-frame
durations) give push p50/p90 **7/10 → 5/6 ms**, and back **8/8 → 5/5 ms**.
This confirms the cheaper prefilter on the Adreno 730. The CPU tail remains:
back UI p99 was 32.16 → 29.60 ms. Steady-frame GPU savings are not a claim
that the destination's initial composition has been fixed.

For this pair, the frame parser also excludes any frame whose intended
vsync predates `Stats since` after reset; a single in-flight old frame can
otherwise survive in the buffer. Both arms use the same filter and validate
Settings/home after each operation, after collecting that operation's frames.

### Expanded profile candidate

Generation on Nothing completed successfully in 10m04s. The baseline grows
25,233 → 27,131 rules; startup grows 25,233 → 25,794 after regenerating the
existing home/chat journey against current sources. Settings composition
and appearance methods now have baseline coverage but do not enter the
startup profile. A fresh-process `settingsCold` case complements the warm
loop so class verification cannot be hidden by eleven warmed iterations.
The six-test paired run passed. These APKs use `1f9265c27`, the same
bilinear glass path and required profile compilation, at 90 Hz on Nothing.

| Journey | Existing CPU p50 / p90 / p99 (ms) | Expanded CPU p50 / p90 / p99 (ms) | Overrun p99 existing → expanded (ms) |
|---|---|---|---|
| Settings warm | 8.66 / 9.94 / 24.37 | 8.59 / 9.93 / 25.38 | 22.39 → 24.07 |
| Settings fresh process | 6.37 / 8.82 / 19.55 | 6.48 / 8.83 / 17.88 | 14.40 → 6.91 |
| Chat | 7.64 / 8.95 / 20.30 | 7.64 / 8.96 / 22.17 | 18.84 → 19.68 |
| Artifacts | 8.23 / 9.37 / 22.63 | 8.23 / 9.26 / 20.75 | 13.98 → 16.36 |
| Agent page | 6.85 / 8.39 / 26.20 | 6.93 / 8.39 / 26.88 | 17.73 → 21.11 |

Fifteen cold starts per arm: median fully drawn 260.15 → 257.11 ms;
median initial display 210.62 → 209.46 ms. Maxima improved (fully drawn
336.15 → 308.90, initial display 281.77 → 256.95), but startup medians
are essentially unchanged. Do not compare cold navigation directly to
warm navigation: process launch can change scheduling/boost state.

The coordinated Fold check passed twelve Settings cycles per profile at
120 Hz. CPU p50/p90/p99 was 5.61/7.64/13.52 → 5.68/8.26/12.06 ms;
overrun p99 11.85 → 9.77 ms, positive overruns 854/1362 → 894/1356.
This is mixed, not a uniform improvement. The runner was removed and the
unchanged dev app restored to the foreground before releasing that slot.

Coverage alone was not sufficient to accept the regenerated profile. The
warm frame results are mostly neutral/mixed; the matched first-visit
latency improvement below is the reason to retain it.

### Tap-to-first-movement method

A bench-only `Happy:navFirstMove:<entry>` marker reports the first sampled
incoming offset that differs from its initial **rounded pixel** offset.
It does not change animation values, duration or easing. Unit tests cover
once-only reporting, identical offsets with/without the callback, and a
subpixel sample that must not report visible movement. Production/debug
builds do not enable the callback.

The input origin is the ACTION_UP event's original `eventTimeNano`, not
the later dispatch time. Convert MONOTONIC to the trace clock using
`eventTimeNano + dispatch.ts - to_monotonic(dispatch.ts)`. The marker's
containing Choreographer frame identifies the app surface-frame token;
join its display token to the SurfaceFlinger FrameTimeline frame. The
display frame's end is presentation. The app frame's end is only buffer
readiness and can precede presentation by roughly 15 ms. A dropped initial
frame, or one HWUI skips without submitting a buffer, must advance to the
next actually presented buffer from that layer. Exclude the nested
`Choreographer#doFrame - resynced…` slice from token parsing; the outer
numbered frame is the RenderThread token.
These checks distinguish composition, first sampled motion and visible
presentation rather than calling the first post-tap draw movement.

### Matched tap latency: profile retained

Twelve warm and twelve fresh-process Settings taps per profile, otherwise
identical marker APKs from `1f9265c27`, Nothing at 90 Hz. Raw traces and
per-tap CSVs are in `old-profile-movement/` and `new-profile-movement/`.
The checked-in analyzer reproduces all 48 samples:

```sh
python3 benchmark/analyze-navigation.py <trace-directory> \
  --out <analysis-directory> --trace-processor <trace_processor-binary>
```

It fails rather than silently dropping a trace that cannot join exactly one
tap, changed-offset marker and presented frame. The
`new-profile-movement/settings-motion-sanity.mp4` is a separate three-tap
visual sanity recording, not part of the timing samples (encoding adds
work). The daily dev app was restored to Personal MacBook Pro home before
the Nothing phone was handed to the refresh/IME/glass task.

| ACTION_UP → presented movement | Existing median / p90 (ms) | Expanded median / p90 (ms) |
|---|---|---|
| Fresh process | 78.35 / 84.93 | 64.30 / 70.93 |
| Warm loop | 80.99 / 93.78 | 79.08 / 82.40 |

The approximately 14 ms first-visit improvement justifies the profile;
warm median is essentially unchanged. Twelve samples do not establish a
universal p90 improvement, and neither result meets the requested <40 ms
target. Profile coverage is not the whole tap-latency problem.

Existing-profile first moved frames: cold six had no submitted buffer and
one was dropped; warm one had no buffer and six were dropped. The
expanded profile had six/no-buffer + three/dropped cold, and three + three
warm. Thus a lower loss count alone does not predict lower latency. The
old cold iteration 002 explicitly shows RenderThread skipping its first
moved frame as `Frame skipped: AlreadyDrawn`; the next buffer is used.

Old cold iteration 000 illustrates the delays: input dispatch takes 2.14
ms; its first Choreographer frame starts 7.10 ms after dispatch. The
destination frame starts at 18.04 ms and takes 18.30 ms, including 4.38 ms
class verification. First changed offset is sampled 39.01 ms after
dispatch (40.11 ms from original input), **not** finished drawing then.
That frame takes another 21.84 ms on main; its buffer is ready at 66.07 ms
from input and presented at 84.93 ms. Old warm iteration 011 additionally
has a 10.70 ms content-capture checker between the first and destination
frames. The current animation deliberately returns the unmoved offset at
play time zero; testing that extra frame is separate from changing the
curve or attributing all delay to the ripple.

The complete build/unit-test gate passed with the marker and candidate
profile: `assembleDebug testDebugUnitTest assembleDebugAndroidTest
:benchmark:assembleBenchmarkBench`.

### Validated live-account journeys

The installed `1f9265c27` dev APK (ART `verify`, preserved as
`main-1f9265-dev-installed.apk`) passed twelve route-guarded push/back
cycles for each journey below. All returned to the expected screen;
Settings/chat/artifacts returned to Personal MacBook Pro home, while agent
details returned to its chat, then home after the batch. The raw Settings
FrameInterval is approximately 11.16 ms (90 Hz mode). No account data was
cleared or written by these navigation checks.

| Journey | Push total p50 / p90 / p99 (ms) | Back total p50 / p90 / p99 (ms) | Push / back missed gfxinfo deadlines |
|---|---|---|---|
| Settings | 16.15 / 18.13 / 62.97 | 13.78 / 17.33 / 77.90 | 33/527 / 27/800 |
| Chat | 13.40 / 21.54 / 52.69 | 12.75 / 17.32 / 82.13 | 38/512 / 31/811 |
| Agent details | 10.62 / 19.67 / 52.71 | 12.64 / 17.70 / 78.86 | 39/449 / 27/544 |
| Artifacts | 14.31 / 19.60 / 35.88 | 13.12 / 16.67 / 72.49 | 41/522 / 27/805 |

Live home keeps drawing after the transition, so these one-second windows
have more frames than the fixture. This is a functional/real-account
characterization, not an isolated before/after performance claim. In
particular, debug compilation and populated live content differ from the
release-code, profiled, offline benchmark.

## Iterations

### 120 Hz checkpoint and retained Home

The `a45d230d5` checkpoint includes the expanded profile and the 120 Hz
request (`3f943b758`). It also includes later glass changes, so comparisons
with the earlier 90 Hz APK do not isolate refresh rate. Twelve warm and
twelve fresh-process Settings cycles per arm passed on both devices.

| Checkpoint tap → presented movement | Nothing median / p90 (ms) | Fold median / p90 (ms) |
|---|---|---|
| Fresh process push | 57.25 / 60.87 | 49.18 / 52.78 |
| Warm push | 67.14 / 76.00 | 49.46 / 52.85 |
| Fresh process Back | 87.53 / 99.08 | 90.46 / 95.71 |
| Warm Back | 91.31 / 96.51 | 89.16 / 97.22 |

A candidate made the zero-time animation sample one frame advanced. It
did not reliably change the first placement: Compose can place the initial
offset without sampling the animation at zero. Nothing cold push was
neutral (56.38 ms), warm median improved but its p90 did not (59.39/75.29).
Fold cold/warm medians were neutral (49.39/50.17). Nothing warm Back
regressed to 98.86 ms. **Rejected**, with the original motion clock restored.

`RetainedHome` instead keeps the actual home tree under NavHost, following
the coordinates of its existing home destination. That destination remains
the transition/scrim carrier, so no second easing or parallax calculation is
introduced. The retained tree has the home entry's lifecycle, saved state
and ViewModelStore, not the activity's. A covered home is undrawn, absent
from semantics, and cannot focus or receive pointers. Its shimmer clock
and lifecycle-aware collectors stop; account-keyed content still changes
when switching accounts from Settings.

Seven tests cover unchanged lazy-item composition/measurement and scroll
identity, saved scroll across host recreation while covered, exact LTR/RTL
anchor motion without exposed backdrop, focus exclusion, account switching,
and predictive Back cancellation/commit. The full build/unit-test gate
passed again with the isolated retention fix and original motion clock:
`assembleDebug testDebugUnitTest assembleDebugAndroidTest
:benchmark:assembleBenchmarkBench :app:assembleBenchmarkBench` (2m40s).

To isolate retention, both device measurement arms below used that same
timing prototype; only retention differed. The signed-in Nothing dev app
used ART `verify`, twelve Settings push/back cycles per arm, preserving
Personal MacBook Pro and all account data. The frame windows include the
live home's post-transition work; these are frame tails, **not tap latency**.

| Live Nothing frames | Before retention | With retention |
|---|---:|---:|
| Back UI p99 | 77.41 ms | 36.92 ms |
| Back total p99 | 112.54 ms | 48.02 ms |
| Back total median | 11.96 ms | 11.98 ms |
| Back missed deadlines | 141 / 939 | 160 / 1010 |
| Push UI p99 | 35.18 ms | 26.70 ms |
| Push total p99 | 74.92 ms | 90.55 ms |

This supports removing the expensive home rebuild, not a universal
smoothness improvement: median and deadline counts did not improve, and
the push total tail was noisy/worse. Offline Nothing warm Settings CPU p99
improved 17.36 → 14.18 ms and overrun p99 19.89 → 11.05 ms. Push latency
remained neutral: cold 56.38 → 58.48 ms, warm 59.39 → 60.78 ms. Fold push
was likewise broadly neutral (cold 49.39 → 51.63, warm 50.17 → 48.15 ms).
Some retained Back traces contain no sampled-offset marker; the strict
analyzer rejects them instead of dropping them. No retained-Back latency
claim is made pending a placement-based marker.

Evidence directories: `main-a45d230-120-baseline`,
`main-a45d230-120-first-draw-motion`, `main-a45d230-120-retained-home`,
their `fold-a45d230-*` counterparts, `dev-a45-timing-settings` and
`dev-a45-retained-settings`. Tagged APKs preserve each arm; none is an OTA
or store release.

| Change | Measurement | Decision |
|---|---|---|
| Navigation benchmark and bench-only Compose tracing | Settings/chat/artifacts device cases pass; agent-page case added | Infrastructure, no shipping UI change |
| Opt out of system content capture | Scans removed, but matched release-code push p99 25.5 → 34.9 ms and back 42.6 → 47.9 ms | Reverted after initial landing; tests retained |
| Three bilinear halvings instead of Gaussian prefilter (`c458fa14e`, glass task) | Matched Nothing GPU median push 7 → 5 ms, back 8 → 5 ms; total frame medians 15.32 → 12.41 and 14.23 → 11.67 ms | Confirmed on Nothing; source unchanged here |
| Settings/artifacts/agent baseline-profile journey | Fresh-process tap→visible-motion median 78.35 → 64.30 ms, p90 84.93 → 70.93; warm median neutral | Retained for first-visit latency, not claimed as a universal frame-time win |

## Remaining checks

- Retained Home passed the isolated full gate, lifecycle/state/gesture
  tests and a matched real-account Nothing comparison. The Fold real-account
  return-frame comparison remains; its offline benchmark passed.
- Reduce tap→presented movement toward <40 ms, isolating the initial
  unmoved frame, composition scheduling and the display queue. Compare
  system Settings navigation without changing its options.
- Tag later builds at/after refresh-rate commit `3f943b758` separately:
  they request 120 Hz. Do not mix their 8.3 ms deadlines with this 90 Hz
  baseline's 11.1 ms deadlines.