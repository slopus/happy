# UX Review Findings

Date: 2026-03-30
Artifact set reviewed: 38 step screenshots + 8 component screenshots in `e2e-recordings/ux-review/`

## Executive summary

The UI language is visually consistent, but the capture set is not reliable enough to prove every UX state. Only 20 of the 46 PNGs are unique by file hash, and several step groups that should show different states are actually identical images. That means the main product UX looks stable, but the review confidence is limited for permission variants, question rendering, resume/reopen transitions, and background-task completion.

## Findings by area

### 1. Visual consistency

- Good: The app uses a consistent visual system across the walkthrough. The layout stays stable: left session rail, large white transcript canvas, pale beige user bubbles, rounded cards, and the same black composer footer/button treatment.
- Good: Typography, spacing, and icon treatment are consistent across the unique frames I inspected. The green `connected` status in the header and the green `online` labels in the transcript/session list are also consistent.
- Weakness: The main transcript pane has a lot of empty white space in many captured states. When there is only one short user bubble or a status-only screen, the view feels visually sparse and under-informative.

### 2. Content visibility

- Mixed: When transcript text is present, it is readable. `step-20-close.png` clearly shows the test-framework question, and `step-31-launch-background-task.png` / `step-29-resume-after-forced-stop.png` show long assistant paragraphs with acceptable line length and contrast.
- Weakness: Many screenshots that should show progression do not expose new transcript content. Several groups are exact duplicates:
  - `step-01` through `step-07` match `component-permission-prompt-approve-once`
  - `step-11` through `step-15` match `component-question-prompt`
  - `step-21` through `step-23` are identical
  - `step-29` through `step-38` mostly collapse to one identical frame, including the background-task and final-summary steps
- Impact: The transcript is readable when populated, but the capture set often fails to show the content that would let a reviewer confirm the intended state transition.

### 3. Permission UX

- Good: The app has a clear orange `permission required` state in both the session rail and near the composer. That state is visible in `step-26-supersede-pending-permissions.png`, `step-28-stop-session-while-permission-is-pending.png`, and `component-multiple-permissions.png`.
- Good: One mixed capture, `step-20-close.png`, shows the action list for a permission prompt with distinct choices:
  - `Yes`
  - `Yes, allow all edits during this session`
  - `No, and provide feedback`
- Weakness: The dedicated permission component screenshots do not reliably expose the actual prompt body. For example, `component-permission-prompt-approve-once.png` is byte-identical to `step-04-edit-approved-once.png` and shows only the baseline chat shell, not an actionable prompt card.
- Weakness: I could not visually confirm all requested variants (`deny`, `once`, `always`) from distinct screenshots, because the artifact set reuses or mislabels frames.

### 4. Question UX

- Good: The question content itself reads cleanly in `step-20-close.png`. The framework options are easy to scan and the assistant's prose is understandable.
- Weakness: `component-question-prompt.png` is byte-identical to `step-12-agent-asks-a-question.png`, and neither shows a dedicated question UI beyond ordinary transcript text. The capture does not prove a distinct "awaiting answer" treatment.
- Impact: The underlying content is fine, but the screenshots do not demonstrate a strong visual distinction between ordinary assistant prose and a state that explicitly requires user input.

### 5. Session lifecycle

- Mixed: Reopen/resume generally preserves the same shell and conversation styling, so the app does not visually "jump" between states.
- Weakness: `step-10-cancel.png` shows a footer CTA `Resume Session` followed by `This session is missing its machine metadata, so it cannot be resumed.` That message is clear, but it is also a rough dead-end state and weakens the lifecycle story.
- Weakness: The dedicated reopen/continuity screenshots are not trustworthy evidence. `step-21-reopen.png`, `step-22-verify-continuity.png`, and `step-23-mark-todo-done.png` are identical files.

### 6. Background tasks

- Good: There is at least some visual language for in-progress work. `component-background-running.png` / `step-31-launch-background-task.png` show a green spinner-style session avatar and blue status text such as `doing...`, `coalescing...`, or `crunching...`.
- Weakness: The capture set does not visually prove completion or interaction differences during background execution. `step-31`, `step-32`, `step-33`, `step-34`, `step-35`, `step-36`, `step-37`, and `step-38` collapse to the same image hash.
- Impact: Running state is represented, but completion/result UX is not actually demonstrated by the screenshots.

### 7. Error state: Step 28 stop-while-pending

- Good: The app appears to fail softly rather than crashing. `step-28-stop-session-while-permission-is-pending.png` still shows the full shell with an orange `permission required` label, not a broken layout.
- Weakness: The error is under-communicated. The screenshot does not explain that the stop action timed out or what the user should do next; it mostly looks like the generic permission-pending state.
- Assessment: Graceful layout-wise, not graceful from a feedback perspective.

## Highest-priority UX issues

1. The screenshot evidence is too duplicated to validate the intended UX states. Only 20 of 46 PNGs are unique.
2. Permission and question states are not visually distinct enough in the captures; most frames look like the normal chat shell plus a small status label.
3. Background-task completion is not reviewable because the "launch", "complete", "interact", and "summary" frames are identical.
4. The cancel/resume edge state in `step-10-cancel.png` ends in a dead-end message about missing machine metadata.

## Recommended next actions

1. Fix screenshot timing/selection in the webreel capture so each labeled step produces a unique frame from the intended UI state.
2. Re-capture permission steps and question steps with the prompt/action region fully visible.
3. Re-capture background-task steps so `running`, `completed`, and `post-result` each have distinct evidence.
4. Consider a more explicit visual treatment for "awaiting permission" and "awaiting answer" beyond small status text.
