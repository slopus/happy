# Nothing Phone navigation

Work in progress, 2026-10-31. Baseline source: `1f1c38d04`.

**Current decision:** the content-capture opt-out in `1be782b7d` is being
reverted. It removed CPU work but did not earn its place as a navigation
performance fix in the controlled release-code comparison. The benchmark
and isolation test remain. No final frame-time improvement is claimed.

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

## Iterations

| Change | Measurement | Decision |
|---|---|---|
| Navigation benchmark and bench-only Compose tracing | Settings/chat/artifacts device cases pass; agent-page case added | Infrastructure, no shipping UI change |
| Opt out of system content capture | Scans removed, but matched release-code push p99 25.5 → 34.9 ms and back 42.6 → 47.9 ms | Reverted after initial landing; tests retained |
| Settings/artifacts baseline-profile journey | Pending generation and A/B measurement | Pending |

## Remaining checks

- Attribute the first destination frame, including real dev account pictures.
- Measure the glass owner's cheaper prefilter on this GPU.
- Measure Settings, chat, agent page and artifacts, and back on dev as well
  as bench. Capture tap-to-first-movement latency separately from frame time.
- Regenerate profiles, compare on the Fold, run the full gate and record
  final source/build identities. No improvement is claimed yet.