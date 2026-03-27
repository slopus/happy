# Loop State

Last updated: 2026-03-26 21:27 PDT

Previous completed tasks are archived in `loop/state-archive.md`.

## Current Task

TASK: Run the full 38-step `webreel` walkthrough with the new harness, then do
Phase 1.5 UX review on the real screenshot set.

### Implemented this iteration

- Added shared flow metadata in `packages/happy-sync/src/e2e/walkthrough-flow.ts`
  so the driver and recorder use the same 38-step definitions.
- Added `packages/happy-sync/src/e2e/walkthrough-driver.ts`.
  It boots isolated server + daemon + Expo web (`BROWSER=none`), spawns a real
  Claude session via SyncNode, writes `e2e-recordings/ux-review/session-url.txt`,
  drives the walkthrough, and writes `walkthrough-driver.done`.
- Added `webreel.config.ts`.
  It reads `session-url.txt`, uses a transcript scroll selector instead of
  `document.documentElement`, records `happy-walkthrough.mp4`, and emits
  per-step screenshots.
- Added `packages/happy-sync/src/e2e/walkthrough-runner.ts`.
  It starts the driver, waits for the session URL, runs `webreel validate`,
  runs `webreel record --verbose`, then verifies the MP4 with `ls` + `ffprobe`
  and writes `walkthrough-verification.json`.
- Added `yarn workspace @slopus/happy-sync walkthrough:webreel`.
- Added `.webreel/` to `.gitignore`.

### Proof From Real Smoke Runs

- `yarn workspace @slopus/happy-sync typecheck`
  - PASS
- Reduced live run:
  - Command:
    `HAPPY_WALKTHROUGH_START_STEP=0 HAPPY_WALKTHROUGH_END_STEP=1 HAPPY_WALKTHROUGH_INITIAL_DELAY_MS=3000 HAPPY_WALKTHROUGH_FINAL_CAPTURE_MS=15000 HAPPY_WALKTHROUGH_POST_DONE_HOLD_MS=15000 HAPPY_WALKTHROUGH_CAPTURE_HOLD_MS=2000 HAPPY_WALKTHROUGH_INTER_STEP_DELAY_MS=1000 yarn workspace @slopus/happy-sync walkthrough:webreel`
  - PASS
  - Produced:
    - `e2e-recordings/ux-review/happy-walkthrough.mp4`
    - `e2e-recordings/ux-review/step-00-open-the-agent.png`
    - `e2e-recordings/ux-review/step-01-orient.png`
    - `e2e-recordings/ux-review/walkthrough-verification.json`
  - Verification:
    - MP4 size: `684138` bytes
    - `ffprobe` duration: `27.400000` seconds
    - Screenshot count: `3` (`happy-walkthrough.png`, step 0, step 1)

### Next Actions

1. Run the same harness with the full default 38-step range and default capture
   timings. Do not use reduced start/end bounds.
2. Verify the resulting MP4 is actually long-form (`>10 min`) and that the
   per-step screenshots show transcript content, not blank/trimmed chrome.
3. If the full run is good, feed the entire screenshot directory to Codex CLI
   and `claude -p` for Phase 1.5 UX review and record findings below.
4. If the full run is not good, fix the harness. Do not rationalize the output.

### Acceptance Criteria

- [x] Background driver script exists and drives a real Claude session via SyncNode
- [x] `webreel.config.ts` exists and records to `e2e-recordings/ux-review/happy-walkthrough.mp4`
- [x] Runner script exists and validates/records/verifies artifacts
- [x] Reduced live smoke run (`0-1`) passed against real infrastructure
- [ ] Full 38-step MP4 exists at `e2e-recordings/ux-review/happy-walkthrough.mp4`
- [ ] Full MP4 duration is > 10 minutes (`ffprobe`)
- [ ] Full MP4 shows transcript growth as steps complete
- [ ] Full screenshot set covers all 38 steps with real content
- [ ] Clean screenshots exist for every component type
- [ ] Phase 1.5 UX review done by TWO reviewers (Codex + Claude)
- [x] Level 2 Codex: 44/44 pass
- [x] Level 2 OpenCode: 44/44 pass

## Blocked / Investigated

- `webreel.config.ts` cannot use `export default` alone.
  The real CLI loaded it as `{ default: ... }` and failed validation with
  `.default Unknown property`. Fixed by exporting CommonJS shape.
- The runner must delete old `e2e-recordings/ux-review/` output before waiting
  on `session-url.txt`. A stale file from a previous run causes validation to
  race against a soon-to-be-deleted path.
- The runner must treat `child.exitCode !== null` as already-finished before
  waiting on an `exit` event. Otherwise it can miss post-record verification.
- The transcript scroll target for `webreel` is currently:
  `[role="list"], div[style*="overflow-y: auto"], div[style*="overflow-y:auto"]`
  This is the first real selector to test in the full 38-step run.

## Simplification Opportunities

- `walkthrough-flow.ts` now centralizes the 38-step flow, but
  `phase1-visual.ts` and `phase1-walkthrough.ts` still have their own copied
  step arrays. After the full run is proven, point those scripts at the shared
  flow file instead of maintaining three copies.

## UX Review Results

Pending the full screenshot set from the new `webreel` harness.

## Completed Tasks

### Webreel walkthrough harness (DONE)

- Implemented the new driver/config/runner path requested by `loop/state.md`
- Proved it works on a real reduced run (`0-1`) against server + daemon + Expo + Claude

### Level 2 Codex + OpenCode verification (DONE)

- Codex: 44/44 pass (1822s)
- OpenCode: 44/44 pass (1518s)

### Screenshot scroll fix (DONE)

- Fixed scroll target from `document.documentElement` to chat container
- Screenshots now show conversation content (verified visually)
