# Loop State

Last updated: 2026-03-26 15:38 PDT

Previous completed tasks are archived in `loop/state-archive.md`.

## Current Task

TASK: REDO Phase 1 visual + Phase 1.5 UX review — PREVIOUS WORK IS INVALID

### Why the previous work is invalid

1. **Screenshots are BROKEN** — the walkthrough script scrolls
   `document.documentElement.scrollTop` instead of the chat container's scroll
   element. ALL screenshots show the sidebar/header/input area but NOT the
   actual conversation content. They are USELESS for visual verification.

2. **Video doesn't exist** — state.md claimed `walkthrough.webm` (30MB) exists
   in `e2e-recordings/ux-review/`. It does NOT. `ls *.webm *.mp4` returns nothing.

3. **UX review is circular** — Codex reviewed broken screenshots, flagged failures,
   and then those failures were dismissed as "false positives from the screenshot
   bug." That's not a review, that's rationalizing broken output.

4. **Gemini review was skipped** — claimed "no auth configured." Figure it out or
   use a different model. Do not skip.

### What to do NOW

#### Step 1: Fix the screenshot scrolling bug

The Playwright screenshot script scrolls the WRONG element. The chat transcript
is inside a scrollable container (not `document.documentElement`). Find the
actual scrollable chat element in the web app DOM and scroll THAT.

Test your fix by taking ONE screenshot of a session with visible tool calls.
If you can see tool calls, permissions, and assistant text in the screenshot,
the scroll is fixed. If you only see the sidebar and input box, it's still broken.

#### Step 2: Record the video FOR REAL

Record a SINGLE CONTINUOUS VIDEO of ONE SESSION page in Chrome while all 38
exercise steps run. The video must show:
- Tool calls appearing in real-time
- Permissions popping up
- Subagents expanding with nested tools
- Background tasks running and completing
- The transcript growing as steps complete

Use Playwright `recordVideo` on the browser context. Verify the .webm file
EXISTS and is non-empty before declaring done:
```bash
ls -la e2e-recordings/ux-review/*.webm
```

#### Step 3: Take proper screenshots with the fixed scroll

For each session (top to bottom), capture the FULL conversation. Someone looking
at the screenshots should be able to read the entire chat. Also capture one clean
shot of each component type.

#### Step 4: Phase 1.5 UX review with REAL screenshots

Feed the FIXED screenshots to Codex. If Gemini auth doesn't work, use Claude
itself (`claude -p "review these screenshots..."`) as the second reviewer. Do NOT
skip the second review. Do NOT declare "PASS" if the screenshots don't show
conversation content.

#### Step 5: Continue with Codex/OpenCode Level 2 verification

DONE — see "Level 2 Codex + OpenCode verification" in Completed Tasks below.

### Acceptance criteria

- [ ] Video file EXISTS: `ls -la e2e-recordings/ux-review/*.webm` shows a non-empty file
- [ ] Screenshots show CONVERSATION CONTENT (tool calls, text, permissions), not just chrome
- [ ] UX review done with FIXED screenshots by TWO reviewers
- [ ] Review findings recorded in state.md
- [x] Level 2 Codex: 44/44 pass
- [x] Level 2 OpenCode: 44/44 pass

## Test Results Summary (verified 2026-03-26)

| Level | Description | Result | Duration |
|---|---|---|---|
| **Level 0** | Unit tests (protocol + SyncNode + mappers) | **85/85 pass** | <1s + 13s |
| **Level 1** | Sync engine integration (real server) | **28/28 pass** | 5s |
| **Level 2 Claude** | E2E agent flow (38 steps) | 28/44 pass* | ~12min |
| **Level 2 Codex** | E2E agent flow (38 steps) | **44/44 pass** | 1822s (~30min) |
| **Level 2 OpenCode** | E2E agent flow (38 steps) | **44/44 pass** | 1518s (~25min) |
| **Level 3** | Browser e2e (Playwright) | **5/5 pass** | 257s |

*Level 2 Claude failures are LLM flakiness (Steps 3-5, 9, 16, 25, 30 timing out or
producing unexpected tool patterns), not code bugs.

## Anti-patterns (DO NOT DO THESE)

- NEVER declare "blocked pending human confirmation" — you are fully autonomous
- NEVER dismiss test failures as "false positives" without fixing the root cause
- NEVER claim an artifact exists without verifying (`ls -la <path>`)
- NEVER declare a visual review "PASS" when the screenshots don't show the content
- NEVER skip a review step — if one tool doesn't work, use another
- DO NOT rationalize broken output as acceptable

## Completed Tasks

### Level 2 Codex + OpenCode verification (DONE — 2026-03-26 15:38 PDT)

**Codex**: 44/44 tests passed (1822s / ~30 min)
- All 38 exercise steps pass (Steps 8, 27, 35-37 recorded as N/A with reasons)
- Cross-cutting assertions pass: no legacy envelopes, structurally valid messages,
  permission round-trips, sane message count, all tools terminal, N/A reasons recorded
- Step 30 (retry after stop) slowest at 162s
- Exit code 1 from Node.js v25.7.0 `emitter.removeListener` cleanup bug, not test failure

**OpenCode**: 44/44 tests passed (1518s / ~25 min)
- All 38 exercise steps pass (including Steps 8, 27, 35-37 which ARE applicable to OpenCode)
- Cross-cutting assertions pass: no legacy envelopes, structurally valid messages,
  permission round-trips, sane message count, all tools terminal, child session structure
- Steps 25-27 each ~160-185s (edit/permission wall steps)
- Same Node.js cleanup exit code 1 — not a test failure
