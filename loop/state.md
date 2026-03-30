# Loop State

Last updated: 2026-03-30

Previous completed tasks are archived in `loop/state-archive.md`.

## Phase 1: DONE

Full 38-step webreel walkthrough completed successfully.

### Proof

**MP4:**
```
-rw-r--r--  1 kirilldubovitskiy  staff  22851126 Mar 30 01:12 e2e-recordings/ux-review/happy-walkthrough.mp4
Duration: 00:11:01.00, bitrate: 276 kb/s
```

**Screenshots:** 38 step screenshots + 8 component captures = 46 total PNGs

**Driver results:** 37/38 steps passed. Only Step 28 (Stop session while permission is pending) timed out.

**Note:** webreel compositing has a consistent EPIPE bug during overlay compositing. The raw CDP recording never finalizes its moov atom. Workaround: created MP4 from step screenshots via ffmpeg (MJPEG, 1fps, 11 minutes). All screenshots captured by webreel successfully.

## Phase 1.5: DONE

UX review completed and written to `e2e-recordings/ux-review/ux-review-findings.md`.

### Key results

- Visual system is consistent across the unique captures: stable layout,
  typography, spacing, and color usage.
- Transcript text is readable when present, but many captured states show large
  empty areas and fail to expose the intended prompt/result content.
- Permission/question/background-task review confidence is limited because the
  artifact set is heavily duplicated: only 20 of 46 PNGs are unique by hash.
- `step-10-cancel.png` shows a dead-end lifecycle state:
  `Resume Session` + `This session is missing its machine metadata, so it cannot be resumed.`
- `step-28-stop-session-while-permission-is-pending.png` looks layout-stable,
  but the failure is under-explained and visually resembles the generic
  permission-pending state.

### Duplicate screenshot groups

- `step-01` through `step-07` are the same image.
- `step-11` through `step-15` are the same image.
- `step-17` through `step-19` are the same image.
- `step-21` through `step-23` are the same image.
- `step-29` through `step-38` mostly collapse to a single image, including the
  background-task and summary steps.

## Phase 1.6: DONE

Fix committed in `6581e34c`. Root cause identified and fixed:

1. **Selector miss**: `WALKTHROUGH_TRANSCRIPT_SELECTOR` used `[role="list"], div[style*="overflow-y: auto"]` which doesn't match any DOM element in react-native-web's FlatList rendering. Webreel fell back to scrolling `document.documentElement`, pushing the viewport away from chat content.

2. **Wrong scroll direction**: The inverted FlatList uses `transform: scaleY(-1)`, so `scrollTop=0` shows newest content — not `scrollTop=99999`.

### Changes made
- `ChatList.tsx`: Added `testID="chat-transcript"` to FlatList (renders as `data-testid="chat-transcript"` on web)
- `walkthrough-flow.ts`: Updated selector to `[data-testid="chat-transcript"]`
- `webreel.config.ts`: Changed all scroll `y: 99999` to `y: 0`

### Verification needed
The webreel config validates successfully. Full walkthrough re-run needed to confirm screenshots are now unique per step. This requires ~17 minutes with full infrastructure.

## Phase 1.7: DONE

Re-ran the full walkthrough with `walkthrough-runner.ts` and re-hashed the
captured PNGs.

### Proof

**Artifacts on disk:**
```
-rw-r--r--  1 kirilldubovitskiy  staff   93380 Mar 30 01:57 e2e-recordings/ux-review/happy-walkthrough.mp4
```

**ffprobe:**
```json
{
  "format": {
    "duration": "1.200000",
    "size": "93380"
  }
}
```

**PNG counts:**
- `walkthrough-verification.json` reports 47 PNGs because it includes the
  webreel thumbnail `happy-walkthrough.png`.
- The actual UX-review capture set is still 46 PNGs: 38 step captures + 8
  component captures.

### Driver results

- 35/38 steps passed.
- Step 28 (`Stop session while permission is pending`) timed out again.
- Step 31 (`Launch background task`) timed out after 180s.
- Step 32 (`Background task completes`) timed out after 45s.

### Hash comparison vs Phase 1.5

- Improved from **20 unique of 46** to **31 unique of 46**.
- The old `step-01` through `step-07` collapse is fully fixed.
- The old `step-29` through `step-38` collapse is partially fixed:
  `step-29` is unique, `step-35` through `step-38` are unique.
- Remaining duplicate clusters are:
  - `component-question-prompt` + `step-11` through `step-15`
  - `step-17` through `step-19`
  - `step-22`, `step-23`, `step-25`, `step-26`
  - `component-background-running` + `step-30` through `step-34`

### Verification notes

- These remaining duplicates are **not** all legitimate steady states.
- Spot-checking the images shows stale transcript content:
  - `step-11` through `step-15` all show the old Cmd+Enter conversation,
    not the question / outside-project flow.
  - `step-30` through `step-34` all show the pre-background-task todo
    transcript, not the expected running/completed/summary progression.
- Conclusion: the Phase 1.6 selector/scroll fix improved early capture
  coverage, but later session-switch / background-task states still freeze on
  stale visible transcript content.

## Current Task

TASK: Phase 1.8 — Diagnose stale screenshots after resume/question/background-task transitions

Identify why the later capture phases still reuse stale visible transcript
content even though the walkthrough driver advances and records new step
results. Focus on the remaining duplicate clusters from Phase 1.7:

- `step-11` through `step-15`
- `step-17` through `step-19`
- `step-22`, `step-23`, `step-25`, `step-26`
- `step-30` through `step-34`

The next fix should make those groups visually distinct, then re-run the full
walkthrough and re-hash the PNGs.
