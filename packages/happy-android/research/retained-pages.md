# Retained navigation pages

Back-stack entries keep their actual Compose trees, list instances and saveable
state. `RetainedNavHost` registers the existing `page<Route>` destinations with
lightweight NavHost anchors and draws each retained page at its anchor's position.
There is no page-count cap. A covered page is not measured, placed, drawn,
focusable or exposed to accessibility. A true pop releases its tree after exit;
real memory pressure evicts covered trees deepest first, preserving saveable
state. `TRIM_MEMORY_UI_HIDDEN` does not evict anything.

The original NavBackStackEntry remains the Lifecycle, ViewModelStore and saved
state owner. Covered entries reach CREATED. Page-owned observers use
`StartedEffect`, while accepted writes, sends and uploads keep their existing
owners. Conversation subscriptions/bootstrap/history reads, agent-page and
surface/catalog observers, LiveText/reveal frames, shimmers, native animated
vectors, loading spinners, voice meter loops and video playback stop when covered.
Inactive pages cannot own Back handlers, dialogs, popups or menus above the active
page. Global account synchronization is deliberately not paused.

WebViews receive per-instance `onPause`/`onResume`. This is not a guarantee that
arbitrary website JavaScript/network timers stop: Android's `pauseTimers` is
process-wide and would also stop the foreground WebView. No global timer pause,
JavaScript disabling or reload is used to fake state preservation.

## Interrupted motion

The chosen full-distance motion is still 450 ms on
`cubic-bezier(0.22, 0.4, 0, 1)`, with 26% parallax and 20% dim. No latency-oriented
first-frame advancement is added.

Two navigation-library edge cases needed explicit handling:

- NavHost enables Back in a composition SideEffect. A quick Back after `navigate`
  but before the new page's first composition could reach the activity's root
  fallback. The retained host updates its handler synchronously from destination
  changes. Page-local Back handlers retain priority.
- Seeking a predictive gesture to zero during an unfinished push did not hold
  the current pixels. The retained host captures current positions/dim, scrubs
  from there, then commits/cancels on the chosen curve over the corresponding
  share of 450 ms. Toolbar/system Back interrupting a push uses the same handoff.
  A new push during a return retargets the retained underlying page from its
  current position. Position continuity is tested; velocity continuity is not
  claimed for cubic-bezier retargeting.

NavHost remains responsible for the stack and normal transitions. Its RESUMED
entry lifecycle is the authoritative settled-position signal: rapid
push/pop/push could otherwise leave a child anchor at an old parallax offset.

## Verification

The final full `:app:testDebugUnitTest` run is green: 2,177 tests, 55 skipped.
Debug, device-test and optimized benchmark APK builds also passed. Earlier
runs caught and fixed retained-tree selector assumptions; one concurrent
R8/full-suite run also hit the existing grouped-sidebar's five-second setup
wait. The final complete rerun without competing R8 work passed.

`RetainedPagesTest` checks exact list instance/index/pixel offset, zero new item
composition or measurement on unchanged Home and Settings returns, memory
pressure and saved-state restoration, process recreation, account changes,
focus/accessibility, observer cancellation/restart, RTL, predictive commit/cancel,
10/50/90% interrupted pushes/pops, rapid retargets, immediate Back before the first
pushed frame, double taps and page-local Back priority. Motion checks sample
positions, dim and rendered pixels. `ConversationTest` also proves accepted draft
writes continue while page observation is paused.

The unmerged Compose test tree intentionally exposes descendants beneath
`clearAndSetSemantics`. Test control lookup excludes retained roots marked
`hideFromAccessibility`; visual motion tests retain layout-node references to
measure outgoing pages without making them accessible.

Device proof is opt-in:

```sh
adb shell am instrument -w -e allowExistingAccount true \
  -e class com.slopus.happy.fixture.NavigationRetentionDeviceTest \
  com.slopus.happy.dev.test/androidx.test.runner.AndroidJUnitRunner
```

It uses an already-open agent account and the production graph/screens, resolving
the existing chief from the catalog. It does not seed, switch accounts, edit
settings, send messages or clear data. The test-only ActivityScenario uses the
real frame clock and UiAutomation input, not Espresso (Fold's OS removed the
InputManager API its installed Espresso dependency expects). It records
`dumpsys meminfo` for Home → chat → agent → chat → Settings → Appearance → profile
→ artifacts, a real OS trim signal, then every Back to Home. A separate test
injects nine tap/Back cycles with requested 45/225/405 ms delays; injection can
queue on a busy UI thread, so the deterministic clock tests establish exact
interruption fractions, not the recordings.

Both device checks passed on Nothing and Fold. Account data was preserved. Local
recordings and all 16 memory stages per phone are in the task evidence directory
under `nothing-perf/*-retained-real-time*`.

PSS includes debug/instrumentation, live account data, caches, GC timing and
screen recording; it is not isolated retained-view cost or production RSS:

| Device | Home | First chat | Eight-page stack | Peak during pushes | Back to Home after trim |
| --- | ---: | ---: | ---: | ---: | ---: |
| Nothing | 179.6 MiB | 203.4 MiB | 183.2 MiB | 203.4 MiB | 181.6 MiB |
| Fold | 258.3 MiB | 327.9 MiB | 350.5 MiB | 356.8 MiB | 337.6 MiB |

Immediate PSS did not fall after the trim signal. The unit tests establish
deepest-first view disposal and scroll restoration; these samples must not be
presented as measured immediate OS-memory reclamation or a leak-free proof.

## Matched frame measurements

The baseline is `d464acbde` (Home-only retention plus the keyboard changes).
`NavigationBenchmark` measures 12 warm iterations each of chat, agent page,
Settings → Appearance and artifacts in the isolated R8/profiled bench app.
`benchmark/analyze-retention.py` extracts the first 650 ms after the measured
push and first Back, excluding the final cleanup Back to Home. It reports main
`Choreographer#doFrame` duration and app FrameTimeline duration separately.
These are frame tails, not tap-to-first-presented-pixel latency. Failed early
Settings-selector attempts are excluded; the valid agent Appearance sentinel is
`Hide projects`, not the relay-account page's Theme/Language labels.