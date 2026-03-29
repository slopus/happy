# Loop State

Last updated: 2026-03-29

Previous completed tasks are archived in `loop/state-archive.md`.

## Current Task

TASK: RUN THE FULL 38-STEP WEBREEL WALKTHROUGH. NOTHING ELSE.

The harness is ALREADY BUILT. Do not rebuild it. Do not refactor it. Do not
"improve" it. JUST RUN IT.

### Step 1: Build happy-coder (if needed)

```bash
yarn workspace happy-coder build
```

### Step 2: Run the walkthrough

```bash
yarn workspace @slopus/happy-sync walkthrough:webreel
```

This will:
- Boot PGlite server + isolated daemon + Expo web
- Spawn a real Claude session
- Send all 38 exercise prompts via SyncNode
- Record the browser with webreel (H.264 MP4, 30fps, CRF 18)
- Take per-step screenshots
- Write verification JSON

### Step 3: Verify output exists

```bash
ls -la e2e-recordings/ux-review/happy-walkthrough.mp4
ffprobe e2e-recordings/ux-review/happy-walkthrough.mp4 2>&1 | grep Duration
ls e2e-recordings/ux-review/step-*.png | wc -l
```

The MP4 must:
- EXIST (not missing)
- Be > 10 minutes long
- Be > 10MB

The screenshots must:
- Be > 20 (ideally 38, one per step)
- Show conversation content (not just sidebar/header)

### Step 4: If it works, commit and update state

Commit the results and update state.md to say Phase 1 is DONE with proof:
- ffprobe duration output
- screenshot count
- ls -la of the MP4

Then set the next task to Phase 1.5: UX review.

### Step 5: If it FAILS, fix the SPECIFIC error and try again

Do NOT rewrite the harness. Read the error, fix the specific issue, run again.
Common issues:
- Expo web not starting: check port conflicts
- Claude timeout: increase step timeouts in walkthrough-driver.ts
- webreel crash: check webreel-record.log
- Disk space: check df -h

### What NOT to do

- DO NOT refactor the walkthrough harness
- DO NOT add new features to the harness
- DO NOT improve "stability" or "detection"
- DO NOT spend time reading docs or exploring code
- DO NOT declare blocked — just run it
- The ONLY acceptable output is a working MP4 + screenshots

## Anti-patterns (DO NOT DO THESE)

- NEVER declare "blocked pending human confirmation"
- NEVER spend the iteration improving infrastructure instead of running it
- NEVER claim artifacts exist without `ls -la`
- The harness has been "improved" for 10+ iterations without producing a full video. STOP IMPROVING. START RUNNING.
