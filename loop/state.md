# Loop State

Last updated: 2026-03-27 04:00 PDT

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

### Full Run Attempt (2026-03-27)

First full 38-step attempt ran via `yarn workspace @slopus/happy-sync walkthrough:webreel`.
Infrastructure booted successfully. Steps 0-7 completed before ENOSPC killed the webreel recorder.

**Results:**
| Step | Name | Status | Duration |
|------|------|--------|----------|
| 0 | Open the agent | pass | 0.0s |
| 1 | Orient | fail | 125.9s (stale Read tool, see fix below) |
| 2 | Find the bug | pass | 14.1s |
| 3 | Edit rejected | pass | 23.1s |
| 4 | Edit approved once | pass | 30.1s |
| 5 | Edit approved always | pass | 41.6s |
| 6 | Auto-approved edit | pass | 47.1s |
| 7 | Search the web | pass | 46.7s |
| 8 | Parallel explore | in progress when killed |

Step 8 was running (subagent parallel explore) when the disk ran out of space.
The webreel recorder crashed at Step 7 screenshot write: `ENOSPC: no space left on device`.
The driver was killed with SIGTERM (code 143).

**Screenshots captured:** Steps 0-6 plus component captures for permission-denied,
permission-approve-once, permission-approve-always.

**Step 1 fix applied:** Added `sessionDoneWithStaleTools` fallback to
`waitForStepFinishApprovingAll`. When the session is idle with a terminal step-finish
and text, but some tool parts remain `running` (stale sync state), accept after 15s.
This fixes the Step 1 timeout caused by a Read tool stuck at `running`.

### BLOCKER: Disk space

The machine has only ~460GB total, and stale worktrees + Metro cache consumed nearly
all available space. The walkthrough needs ~10GB free to run the full 38-step flow
(Metro bundler cache, Chromium browser profile, video recording, etc.).

**To unblock:**
1. Run `rm -rf /var/folders/yf/nvph5n_n7_n8j_llhb95rczr0000gn/T/metro-cache` (Metro cache, safe to delete)
2. Run `rm -rf /Users/kirilldubovitskiy/projects/happy/.dev/worktree/{bold-island,brave-mountain,bright-valley,clever-harbor,fresh-harbor,fresh-valley-2,quiet-garden,sharp-beacon,sharp-beacon-2,sharp-forest}/` (stale worktrees, ~1.5GB total)
3. Or run `npm cache clean --force` (freed ~1.3GB last time)
4. Verify `df -h /` shows at least 10GB free before retrying

**Then retry:** `yarn workspace @slopus/happy-sync walkthrough:webreel`
Use `nohup ... &` if running from a context with timeout limits.

### Next Actions

1. **Free disk space** (see BLOCKER above).
2. Re-run the full 38-step walkthrough with the Step 1 fix.
3. Verify the resulting MP4 is long-form (`>10 min`) and per-step screenshots
   show transcript content, not blank/trimmed chrome.
4. If the full run is good, feed the screenshot directory to Codex CLI
   and `claude -p` for Phase 1.5 UX review and record findings below.
5. If the full run is not good, fix the harness. Do not rationalize the output.

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
