# Loop State

Last updated: 2026-03-26 13:00 PDT

Previous completed tasks are archived in `loop/state-archive.md`.

## Current Task

TASK: Fix continuity bug + Phase 1.5 UX review + missing steps 35-38

### 0. REDO THE VISUAL WALKTHROUGH PROPERLY

The previous screenshots are garbage. There's no full story of a single chat —
just random scroll-position captures. We need a COMPLETE visual narrative.

**Requirements for the new walkthrough:**

1. **VIDEO RECORDING** — use Playwright's `recordVideo` or agent-browser's
   recording feature. Record a SINGLE VIDEO of ONE SESSION running through the
   FULL 38-step exercise flow. The video should show the browser with the session
   page open, scrolling through the transcript as each step completes, showing
   tool calls appearing, permissions popping up, subagents expanding, background
   tasks running — the ENTIRE experience from step 0 to step 38 in one continuous
   recording. Save to `e2e-recordings/ux-review/`. NO EXCUSES — the previous
   walkthrough had ZERO videos. This was explicitly requested multiple times.

2. **Full-chat screenshots** — for EACH session (not random scroll positions):
   - Screenshot at the TOP of the chat
   - Screenshot scrolled to EACH major step/interaction
   - Screenshot at the BOTTOM
   - The goal is: someone looking at these screenshots can reconstruct the
     entire conversation flow from start to finish

3. **Component-type screenshots** — one clean screenshot of each component type:
   subagent with nested tools, permission prompt, denied permission, approved
   permission, background task running, background task completed, question,
   todo, error tool, web search result, etc.

4. **Watch for CONTINUITY** — the previous walkthrough showed Claude saying
   "I DON'T HAVE ANY CONTEXT FROM THE PREVIOUS SESSION". You MUST watch for
   this and flag it. If a new session doesn't have prior context, that's
   either a bug to fix or a UX issue to document clearly.

Save ALL artifacts to `e2e-recordings/ux-review/` (gitignored, in-repo).

### 1. FIX BUG: Session continuity broken

A screenshot from the visual walkthrough shows Claude saying "I DON'T HAVE ANY
CONTEXT FROM THE PREVIOUS SESSION" in the middle of the conversation. This is a
real bug — when we spawn a new session (Steps 11, 21, 29), the agent should have
access to the prior session's context, or at minimum the transcript should show
this limitation clearly.

**Investigate and fix:**
- Which step(s) show the continuity failure?
- Is this a SyncNode issue (not passing history to the new session)?
- Is this a daemon issue (new CLI process has no context)?
- Is this expected for separate sessions? If so, is the UX clear about it?
- Take a screenshot of the fix if applicable

### 2. Run steps 35-38 (new background subagent steps)

Steps 35-38 were added to `environments/lab-rat-todo-project/exercise-flow.md`
but never run. They test:
- Step 35: Background subagent (TaskCreate)
- Step 36: Check background result (TaskOutput)
- Step 37: Multiple background tasks concurrent with foreground
- Step 38: Final summary

Run these as part of the new visual walkthrough. Take screenshots + video.

### 3. Phase 1.5: UX consistency review by Codex + Gemini

After the new walkthrough with proper screenshots + video:

1. Collect ALL screenshots into `e2e-recordings/ux-review/`
2. Call `codex` CLI giving it the screenshot directory path with this prompt:

```
You are reviewing the UI of "Happy", a developer tool that shows real-time
coding agent sessions (Claude, Codex, OpenCode) in a web dashboard. These
screenshots show every component type the app renders: tool calls, permissions,
subagents, questions, background tasks, session list, etc.

Review ALL screenshots together for:
1. Visual consistency across screens (spacing, colors, typography, icons, alignment)
2. Consistency across the entire experience flow (does it feel cohesive?)
3. Any obvious UI bugs (overlapping elements, missing icons, broken layouts)
4. UX best practices for developer tool dashboards

This is a refactored codebase. The UI was good before — we need to verify
the refactor didn't introduce visual regressions. Flag only real issues,
not style preferences.
```

3. Call `gemini` CLI with the same screenshots and same prompt
4. Compare both reviews, record findings below
5. Fix any real inconsistencies before Phase 2

### 5. THEN Phase 2: automated e2e test

Only after all above is done.

## Bugs Found in Visual Walkthrough

- [ ] **Session continuity**: Claude says "I don't have context from previous
  session" — visible in walkthrough screenshots. Needs investigation + fix.
- [ ] **Session title "unknown"**: mcp__happy__change_title succeeds but title
  doesn't update in the web UI header/session list. Pre-existing.
- [ ] **Raw project path**: Full temp dir path visible on home page between
  session cards.

## What NOT to do

- DO NOT declare tasks done without fixing the continuity bug
- DO NOT skip Phase 1.5 UX review
- DO NOT edit *.test.ts files until Phase 1.5 is complete
- DO NOT rationalize skipping steps

## Anti-patterns (DO NOT DO THESE)

- DO NOT run unit tests and declare "all tests pass" when integration tests are skipped
- DO NOT declare acceptance criteria "done" based on code existing — it's done when TESTS PROVE IT
- DO NOT declare "Phase 1 done" after covering 3 out of 34 steps
- DO NOT rationalize skipping steps with "diminishing returns"
- Skipped tests are FAILURES, not successes
- **NEVER declare "blocked pending human confirmation/review"** — you are fully
  autonomous. Make your best judgment call and KEEP WORKING. If files disagree,
  trust exercise-flow.md as source of truth for step count. DO NOT STOP.
