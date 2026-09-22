# Web transcript scroll ownership

The Web transcript routes programmatic writes through `WebTranscriptScrollCoordinator.driver`.
Interaction ownership and the history transaction are independent. A history commit can compensate
one surviving DOM anchor once; ordinary layout/height revisions do not request compensation.
Native keeps its existing list and reading behavior, including the native anchor sheet.

Web reading capture runs after 250 ms without scroll activity, and is suspended during history
transactions and pending target mounts. The timer checks the latest activity timestamp instead of
being recreated for every event. Offscreen anchor navigation completes from row layout, not a
120 ms retry. The anchor button remains available after scrolling.

## Checks

- Component regression: a wheel of -60 at offset 900 issues no history load or scroll write.
- Coordinator: one compensation per transaction, cancellation on reversal/reset/jump, idle-only
  capture, and target-row cancellation by user input.
- Real RN Web vendor class: normal updates do not measure anchors; missing/disconnected anchors
  do not fall back to estimated multi-screen offsets; retained render masks stay bounded.
- Existing native pagination, stream-following, reading restoration, browser progress and public
  transcript cases remain part of the regression suite.

On 2026-09-23, Ego browser ran the synthetic fixture at
`packages/happy-app/scripts/fixtures/scroll-coordinator-browser.tsx` with the production adapter
and coordinator. A physical wheel changed offset 900 to 840 with zero programmatic writes.
Five 20-row prepends each issued exactly one write; visible message `104` stayed at -119 px
relative to the viewport (0 px drift). Mounted rows stabilized at 28 while loaded rows reached
200. An ordinary React update issued zero writes. No production account or data was used.

To build the fixture, use the app workspace's `pnpm exec esbuild` with `--bundle`,
`--define:process.env.NODE_ENV='"production"'`, `--define:__DEV__=false`, and an output file in a
temporary directory. Serve that directory on loopback with an HTML entry referencing the bundle.
Browser automation must use Ego.

## Remaining acceptance

The fixture verifies geometry ownership, not the full application's rendering performance.
The original authenticated long conversation still needs a before/after production Trace after
review and the normal Web release. Variable-height media, history eviction and streaming should
be included in that run. Do not infer end-to-end latency or heap stability from these unit tests.
Development traces expose bounded `transcript:history-request`, `transcript:anchor-compensation`,
`transcript:history-settled` and `transcript:reading-capture` marks.

The RN Web compatibility adapter still uses private render-mask APIs; its vendor-class tests
remain an upgrade gate. Automatic refill for already-evicted blank extents remains supported.
