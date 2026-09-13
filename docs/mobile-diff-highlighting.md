# Mobile diff highlighting

Syntax stays off in the synchronous diff builder. A mounted diff builds its
base rows immediately, then requests syntax for complete hunks intersecting
its displayed preview. It reserves the exact layout (including wrap/split)
but does not expose the code body visually or to accessibility until syntax
settles, or one second elapses. Tool headers, permission controls, and prose
are never held behind this gate.

The first reveal deadline includes queue time and does not restart when new
streaming input replaces pending input. Once painted, a version is frozen;
late syntax fills the cache for the next visit. Source updates never blank an
already painted view. Syntax changes do not reset progressive row mounting.
"Show more" keeps existing rows visible and shows a disabled busy button while
preparing the additional hunks, then expands colored or falls back after one
second. Cached expansions happen immediately without a busy state.

## Execution and caching

- Native: the existing `react-native-worklets` package supplies one dedicated
  Hermes runtime, not the animation/UI runtime. Prism initialization and
  tokenization happen in scheduled work, not the synchronous initializer.
- The generated, self-contained factory contains the existing Prism core and
  grammars. No library patch, manual native eval, or experimental app-wide
  Worklets Bundle Mode. Native requests and replies cross as JSON strings.
- Web: a real browser Worker uses the same factory. If workers are unavailable
  or CSP blocks them, rendering falls back to plain; there is no synchronous
  tokenization fallback on the rendering thread.
- The service survives Fast Refresh to avoid leaking native runtimes. Fully
  reload the app after changing worker implementation/grammars.
- FlashList measurement cells do not request work. Mounted prefetched chats
  and overscan cells prepare nearby content before focus/scroll; visible cells take priority over them.
  Viewability changes notify only affected cells, not the entire ChatList.
- Requests for identical content/language share one job. Unmount cancels a
  consumer; the last consumer cancels a queued job. An active job may finish
  into the cache. Only one job runs at a time; at most 64 requests are queued.
- Both base documents and syntax results use the same small LRU implementation.
  Syntax has a 512-entry, approximately 4 MiB budget. Keys contain exact hunk
  text/types and language, not filename or theme. No disk cache.
  Tool cards and file panels share entries only when text and line-type
  sequences match exactly; different context widths can produce different keys.
- A hunk exceeding 2,000 lines, 128,000 characters, or a 2,000-character line
  remains plain. Results exceeding 20,000 token runs also fall back. Whole
  hunks preserve multiline lexical context; the engine never guesses lexer
  state by independently tokenizing viewport lines.

The one-second deadline is a **UI waiting budget**, not a native hard-kill
guarantee. Prism has no interruptible `tokenize` API; Worklets 0.7 has no public
runtime termination API. A timed-out job keeps its worker slot until it really
finishes. No replacement threads are spawned. Other requests can time out
plain while the main JS thread remains responsive. Grammar checks between
old/new sides prevent starting additional work after the CPU budget expires.
Deadlines belong to individual consumers, not shared jobs. Timeout/cancellation
never enters the cache: unstarted work is dropped when its last reader leaves
or times out, and a later mount can request it afresh. Only actual computation
results are cached. One input failure does not disable the worker for other
files; infrastructure failures fail plain without retry storms.

## Unit verification

From the repository root:

```sh
pnpm --filter @slopus/happy-wire build
pnpm --filter happy-app typecheck
pnpm --filter happy-app exec vitest run sources/components/diff sources/components/tools/ToolView.test.ts sources/components/tools/knownTools.spec.ts sources/utils/codexUnifiedDiff.spec.ts sources/utils/codexPatchEntry.spec.ts
DIFF_BENCH=1 pnpm --filter happy-app exec vitest run sources/components/diff/engine/benchmark.spec.ts
```

The tests cover actual Worklets Babel transformation with an empty captured
closure, isolated execution with no React/DOM imports, cold grammar loading,
native transport (mocked bridge), exact reveal timing, streaming replacement,
late results, cancellation/refcounting, priorities, LRU eviction/memory bounds,
preserving text/emphasis/layout, and filename propagation from tool views.

After changing the worker, highlighting engine, or Prism dependency:

```sh
pnpm --filter happy-app generate:diff-syntax
```

A unit test rejects stale generated output. `esbuild` is a pinned dev-only
dependency; no new native module needs installing for this change.

Headless Node baseline from this implementation (median of five builds, warm
grammars, cold document cache; CPU only, not native rendering):

| Fixture | Rendered rows | Syntax on | Syntax off |
| --- | ---: | ---: | ---: |
| Chat edit, 40 source lines | 23 | 0.3 ms | <0.1 ms |
| File, 400 source lines | 223 | 1.5 ms | 0.2 ms |
| File, 4,000 source lines | 2,016 | 9.0 ms | 0.8 ms |
| PR, 12 files | 1,877 | 8.7 ms | 0.7 ms |
| Huge PR, 60 files | 19,564 | 77.7 ms | 8.9 ms |

The benchmark now explicitly enables syntax in its "full" column. Previously
both that column and "no-syntax" inherited syntax-off behavior.

## Manual integration checklist

No device, browser, or Maestro integration run was performed for this change.
Use a native development build that already includes Worklets. For performance
decisions, repeat on a physical device in a release-like build; Node timings
and simulator/dev timings are not Hermes device guarantees.

1. Open `/dev/diff-bench` (deep link `happy://dev/diff-bench`). Keep **syntax**
   and **worker** on. Choose **file**, then **cold cache**. Code should first
   appear colored; at worst it appears plain after approximately one second.
   The reserved space must not expose selectable/invisible code to VoiceOver.
2. Press **rerun** without clearing syntax cache. Code should appear immediately,
   with cache hits increasing and no extra native runtime startup. Switch
   light/dark themes: colors change without new tokenization.
3. Try **big file**, then **huge PR** in **pr** mode. Fling both directions.
   Visible content takes priority, offscreen queued requests are cancelled,
   and no syntax-related input/scroll freeze occurs. Ordinary Changes screens
   start collapsed; headers alone must not start highlighting work.
4. Stream real Edit, Write, MultiEdit, Codex patch, and Gemini edits. Confirm
   `.ts/.tsx/.py` files have meaningful syntax colors. Permission controls and
   prose should appear without waiting for code. Existing code must not blank
   again on permission-to-running/completed updates or rapid new input.
5. Try **show more**: the button becomes busy, existing rows stay visible, and
   the added rows appear colored (or plain by the one-second cap). Repeat taps
   do nothing while busy. Then try wrap and split layouts, horizontal scrolling, text selection, and
   expanding/collapsing work groups. Numbers, +/- markers, word-level emphasis,
   and selected text must match the plain diff. Coloring alone must not shrink
   rows or move the reading position. Repeat on Android as well as iOS.
6. Open a diff with a very long minified line, unknown extension, or enormous
   hunk. It must remain readable/plain immediately, without a crash. To inspect
   deadline behavior, use the huge-PR stress preset on a slower device; exact
   one-second and hung-worker cases are deterministically covered in unit tests.
7. Compare an inline edit/patch with View Changes. File headings must meet the
   code without a padding strip or border, and long code lines should scroll
   horizontally under the pinned gutter in both. The chat line-number setting
   still applies; chat also keeps its shorter preview limit. Whitespace-only
   edits must remain visible. Check that the Changes route has no right-side
   toolbar, its back button works, and an unavailable comparison still offers
   an inline retry. The session-detail title should be centered and truncate
   without running into the back button. Compare `+/-` counts in grouped and
   flat lists, the chat subtitle, and session details: all use the grouped
   list's original 11px regular Plex face/weight.

### Reading measurements

Search Metro/app logs for `[perf] diff syntax`:

- `runtime startup`: synchronous runtime creation; should occur only once per
  app reload, even across navigation and Fast Refresh.
- `queue`, `compute`, `total`: per-hunk waiting, actual worker tokenization, and
  end-to-end latency. `status=timeout` records missed deadlines; `late-*` means
  the result was cached without recoloring the current mount.
- `receive`, `bytes`: native reply JSON parse cost and payload size.
- `apply`, `rows`: JS cost of merging colors onto displayed rows.
- `reveal wait`, `settled`: time the first-paint gate held the body.
- Cache-hit counts in the benchmark: repeat content reused without tokenization.

Cache hits are counters only. Reveal/expansion logs and inexpensive receive/apply
logs are dev-only; release builds retain lifecycle/results/timeouts/errors and
receive/apply events exceeding 2 ms.

The benchmark's **build** is base-engine work in worker mode. **mount** is
layout time, not time-to-colored-reveal; use the reveal log for that. JS/UI FPS
and worst frame show rendering/scrolling cost separately from worker compute.
For a synchronous comparison use **file** mode, syntax on, worker off; syntax
off disables both synchronous and asynchronous highlighting. In PR mode the
file list always builds its own base documents, so use worker on for syntax.

Investigate any ordinary diff waiting beyond roughly a second, repeated
runtime startups, increasing queue size after leaving a screen, or consistently
large `receive`/`apply` times (target a few milliseconds, not a frame's worth).
The worker CPU number alone is not a rendering-performance measurement.