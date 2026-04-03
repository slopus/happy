# UX Review Findings

Date: 2026-03-30 (revised after Phase 2.2 validation)

Artifact set reviewed: 32 screenshots across three validated slices in
`e2e-recordings/phase-2-2-validation/` (steps 0-10, 16-23, 25-28).
30 of 32 PNGs are unique by file hash. The only duplicates are the three
pre-decision permission prompt component captures, which is expected behavior
(see Section 3).

Prior artifact provenance: the canonical `e2e-recordings/ux-review/` directory
held 46 PNGs (38 steps + 8 components) from the Phase 1.8 run, verified at
44/46 unique. Those PNGs have since been cleaned up. This review is based on
the Phase 2.2 targeted validation slices, which re-ran the walkthrough driver
with the Phase 2.1 lifecycle fixes applied.

## Executive summary

The web UI is visually consistent and functionally sound across the 32
validated captures. Every step produces a unique, content-rich screenshot.
The Phase 2.1 lifecycle fixes resolve both user-facing issues found in the
original review: the dead-end Resume button (Step 10) is gone, and the
stop-while-pending state (Step 28) now shows clear denial feedback. Permission
decisions, session continuity, and tool status rendering all work as intended.

## Findings by area

### 1. Visual consistency

- The app uses a stable layout across all captures: session rail on the left,
  white transcript canvas, pale beige user bubbles, and a consistent black
  composer footer with the green "Start New Session" CTA.
- Typography, spacing, and icon treatment are uniform. The green `connected`
  status badge in the header and session rail is consistent across sessions.
- Code blocks render with proper syntax highlighting and diff formatting
  (visible in Steps 3, 4, 9).
- Tool call cards have a clean, uniform presentation: tool name, file path,
  and a status label (`Completed`, `Running`, `Error`).

### 2. Content visibility

- Every step screenshot shows unique transcript content that matches the
  expected walkthrough progression. The old duplicate-cluster problem (20/46
  unique in the original capture set) is fully resolved.
- Transcript text is readable at all captured states. Long assistant responses
  (Steps 5, 7, 8, 22, 25) show acceptable line length and contrast.
- Code diffs are clearly formatted. Step 3 shows a full diff block with the
  bug fix, and the user's denial reason is visible in the conversation flow.
- Tool file paths are shown in full, which is useful for developer context but
  can be visually noisy in longer tool chains (Steps 5, 6, 25, 27).

### 3. Permission UX

- **Deny flow (Step 3):** The denied Edit shows the diff in the transcript
  with "No — show me the diff first" as the user's denial choice. The tool
  card does not show an error state — it simply wasn't executed. The
  conversation continues naturally.
- **Approve-once flow (Step 4):** The Edit tool shows `Completed` status.
  The "Yes" approval is visible in the conversation. The tool card renders
  inline with the result.
- **Approve-always flow (Step 5):** Multiple Edit tools auto-complete without
  further prompts. The transcript shows accumulated work from the always-
  approve decision.
- **Multiple permissions in one turn (Step 25):** A Write tool is first
  `blocked`, then completed after approval. Multiple Edit tools follow in
  sequence, all completing. The transcript shows the full refactoring summary.
- **Subagent permission (Step 27):** The Agent tool completes with subagent
  work visible in the transcript. Read calls show `Running` status while the
  subagent works.
- **Pre-decision component captures:** The three component screenshots
  (`component-permission-prompt-denied`, `approve-once`, `approve-always`)
  are byte-identical because they all capture the same "Awaiting approval"
  dialog before the user's decision. Post-decision outcomes are visible in
  the step screenshots (Steps 3, 4, 5). This is expected, not a bug.

### 4. Session lifecycle

- **Cancel (Step 10) — FIXED in Phase 2.1:** The footer shows only
  `Start New Session`. The old dead-end `Resume Session` button with
  "This session is missing its machine metadata, so it cannot be resumed"
  is gone. The session ends cleanly with no misleading CTA.
- **Close (Step 20):** The session closes cleanly. The transcript shows the
  full conversation history including the compaction exchange and file
  modification summary.
- **Reopen (Step 21):** The reopened session renders normally. The transcript
  loads the previous conversation context.
- **Verify continuity (Step 22):** The agent correctly recalls the due-date
  work, the three-item todo list, and the specific files modified. The
  conversation flows naturally from the resumed context. `continuityWarning:
  false` in the driver results confirms no continuity break.
- **Mark todo done (Step 23):** The TodoWrite tool completes successfully.
  The agent confirms "Add due dates to todos" is marked completed and offers
  to continue with the remaining tasks.

### 5. Stop-while-pending UX — FIXED in Phase 2.1

- **Step 28:** The permission UI now shows a clear denied/stopped state:
  - The Edit tool transitions to `Error` status (visible in the tool card).
  - The transcript shows "Request interrupted by user for tool use" as the
    denial reason.
  - The deny option ("No, and provide feedback") appears selected.
  - Approval buttons are no longer interactive — the session is clearly ended.
- **Component capture (`component-permission-prompt-pending-stop`):** Shows
  the session state with multiple completed tools and the session title
  change, providing context for why the stop was triggered.
- This is a significant improvement over the original capture, which showed
  an ambiguous pending state indistinguishable from normal permission-waiting.

### 6. Tool status rendering

- Tool cards consistently show status labels: `Completed` (green context),
  `Running` (active), `Error` (after stop/denial).
- File paths in tool cards are full absolute paths, which is accurate but
  verbose. This is a minor visual density issue, not a bug.
- The Edit tool in Step 28 correctly transitions from `Running` to `Error`
  when the session is stopped, providing clear visual feedback.

### 7. Todos and structured data

- **Step 16 (Create todos):** The TodoWrite tool creates three tasks. The
  transcript shows the task list with pending status markers.
- **Step 23 (Mark todo done):** The TodoWrite tool marks a task completed.
  The agent's response references the specific task and remaining work.
- The todo integration works end-to-end through create, persist across
  close/reopen, and update via tool calls.

## Remaining gaps

1. **Steps 11-15 (question flow) and 29-38 (background tasks, resume, summary)
   are not covered by the Phase 2.2 validation slices.** The Phase 1.8 full
   run showed these as unique captures (44/46 overall), but they have not been
   re-validated with the Phase 2.1 code changes. No regressions are expected
   since the lifecycle fixes only touch PermissionFooter and
   useSessionQuickActions, but the evidence gap exists.
2. **The three pre-decision permission component captures are identical by
   design.** If distinct per-decision-type captures are desired, the capture
   point would need to move to post-decision, which adds synchronization
   complexity.
3. **Long file paths in tool cards** create visual noise in dense tool chains.
   This is cosmetic and low-priority.

## Resolved issues (from original review)

1. ~~Screenshot evidence too duplicated (20/46 unique)~~ — Resolved in Phase
   1.6/1.8. Current validated set is 30/32 unique (only expected duplicates).
2. ~~Dead-end Resume button in Step 10~~ — Fixed in Phase 2.1. Button is now
   hidden when the session cannot be resumed.
3. ~~Stop-while-pending under-communicated in Step 28~~ — Fixed in Phase 2.1.
   Denial reason and disabled buttons now shown.
4. ~~Reopen/continuity screenshots identical~~ — Resolved in Phase 1.8 capture
   fixes. Steps 20-23 are all unique with distinct content.
5. ~~Background-task captures collapsed to one image~~ — Resolved in Phase 1.8
   (verified at 44/46 unique in full run, though not re-validated in Phase 2.2).
