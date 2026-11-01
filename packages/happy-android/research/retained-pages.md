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

Candidate production source is `b368b6a2`. Each cell below is baseline → candidate
in milliseconds, pooled p99 across 12 valid iterations of that journey and
direction. These sequential device runs are not randomized trials.

| Device | Journey | Direction | Main-thread p99 | App-frame p99 |
| --- | --- | --- | ---: | ---: |
| Nothing | Chat | Push | 12.99 → 7.79 | 18.20 → 14.40 |
| Nothing | Chat | Back | 6.10 → 4.83 | 11.32 → 13.26 |
| Nothing | Agent page | Push | 12.71 → 6.17 | 21.16 → 12.97 |
| Nothing | Agent page | Back | 16.42 → 4.99 | 18.97 → 16.14 |
| Nothing | Appearance | Push | 8.77 → 7.23 | 15.08 → 14.38 |
| Nothing | Appearance | Back | 18.98 → 4.75 | 22.67 → 14.57 |
| Nothing | Artifacts | Push | 8.14 → 7.05 | 15.25 → 13.82 |
| Nothing | Artifacts | Back | 7.00 → 5.06 | 12.20 → 14.18 |
| Fold | Chat | Push | 7.09 → 6.06 | 12.61 → 11.69 |
| Fold | Chat | Back | 5.08 → 4.81 | 14.91 → 13.71 |
| Fold | Agent page | Push | 7.88 → 7.44 | 14.17 → 12.04 |
| Fold | Agent page | Back | 9.57 → 4.13 | 13.49 → 11.12 |
| Fold | Appearance | Push | 6.57 → 4.52 | 14.90 → 11.66 |
| Fold | Appearance | Back | 11.75 → 4.05 | 15.59 → 13.39 |
| Fold | Artifacts | Push | 5.13 → 4.28 | 12.01 → 11.01 |
| Fold | Artifacts | Back | 3.83 → 4.41 | 12.80 → 13.75 |

The strongest change is returning to non-Home pages: agent-page and Settings
main-thread p99 falls by about 57–75%. Home was already retained in the baseline;
chat/artifact returns are controls, not evidence of eliminating a Home rebuild.
They do not all improve: Nothing chat/artifact Back app-frame p99 rises about
17%/16%, and Fold artifacts rises about 7% (main-thread p99 also rises 15%).
Back main-thread medians increase across all four journeys on both devices
(Nothing baseline 1.84–2.62 ms versus candidate 3.28–3.82 ms; Fold 1.03–1.35 ms
versus 1.76–1.99 ms). Thus this establishes smaller expensive return spikes and
retained-state correctness, not uniformly lower animation cost or jank. The
analyzer preserves FrameTimeline jank labels/counts; those include buffer
stuffing and must not be equated directly with missed app deadlines.

Fold's final combined benchmark passed all four tests. Nothing's combined run
passed chat, agent page and artifacts, then failed to find Appearance during
Settings setup at iteration 9. That incomplete Settings set is excluded. The
unchanged isolated Settings rerun passed all 12 iterations; the setup failure's
cause is unconfirmed, and the failed capture is preserved rather than hidden.

Raw trace directories under the task's `nothing-perf` evidence directory:

- Baseline: `{nothing,fold}-d464-retention-baseline` (chat, agent page,
  artifacts only) and `{nothing,fold}-d464-settings-baseline-valid`.
- Candidate: `fold-retained-pages-final`, `nothing-retained-pages-final`
  (excluding its incomplete Settings set), and
  `nothing-retained-settings-final-valid`.
- Parsed frames and exact summaries: `{nothing,fold}-retention-before-analysis`,
  `{nothing,fold}-retention-settings-before-analysis`,
  `{nothing,fold}-retention-after-analysis`, and
  `nothing-retention-settings-after-analysis`.

The final commit-labeled debug APK was installed with data-preserving upgrades
on both phones. Both repeated the nine-cycle rapid tap/Back check successfully
after that install, then received the documented `cmd package compile -m verify`
step. No OTA or store release was performed.