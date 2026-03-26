# Loop State

Last updated: 2026-03-26 15:10 PDT

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

Only after the above is solid.

### Acceptance criteria

- [ ] Video file EXISTS: `ls -la e2e-recordings/ux-review/*.webm` shows a non-empty file
- [ ] Screenshots show CONVERSATION CONTENT (tool calls, text, permissions), not just chrome
- [ ] UX review done with FIXED screenshots by TWO reviewers
- [ ] Review findings recorded in state.md

## Anti-patterns (DO NOT DO THESE)

- NEVER declare "blocked pending human confirmation" — you are fully autonomous
- NEVER dismiss test failures as "false positives" without fixing the root cause
- NEVER claim an artifact exists without verifying (`ls -la <path>`)
- NEVER declare a visual review "PASS" when the screenshots don't show the content
- NEVER skip a review step — if one tool doesn't work, use another
- DO NOT rationalize broken output as acceptable
