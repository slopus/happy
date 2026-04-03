# UX Verification Spec

Source of truth: `exercise-flow.md` (34 interactions; numbering intentionally
skips `24`). This file defines what "renders correctly" means for Level 3
browser verification via `agent-browser`.

## Verification Method

A coding agent walks the web UI using `agent-browser`, verifying that the
rendered transcript matches these requirements. Screenshots are captured and
read natively by the coding agent (multimodal image reading).

Tools: `agent-browser open`, `agent-browser snapshot` (accessibility tree),
`agent-browser click`, `agent-browser fill`, `agent-browser screenshot`.

## Per-Step Browser Assertions

### General (apply to every step)

- User messages render as user bubbles with the original text.
- Assistant text renders as formatted markdown, not raw JSON.
- Tool calls render with clean titles and expandable output.
- No raw `tool_use_id`, `parent_tool_use_id`, `call_id`, or provider-native
  JSON visible anywhere.
- No raw `exec_command_begin`, `exec_command_end`, `patch_apply_begin`,
  `patch_apply_end` events visible (Codex-specific).
- No raw JSON blobs anywhere in the visible transcript.
- Session is scrollable, all steps present in order.
- Screenshots at key moments are visually correct — layout not broken, text
  readable, no overlapping elements.

### Step-Specific

**Step 0 — Setup**: Session appears in session list. Opening it shows empty
transcript or welcome message.

**Steps 1-2 — Transcript**: Assistant responses render as formatted text
blocks. Tool calls (file reads) show clean titles with expandable output
sections. Step boundaries are not visible as raw markers.

**Steps 3-6 — Permissions**: Permission prompts render with approve/deny UI
and tool description. Resolved permissions show the decision (once/always/
reject). Rejected tools show error state. Auto-approved tools show no
permission prompt.

**Step 7 — Web Search**: Web search tool part renders with clean title and
result output.

**Step 8 — Subagents**: Subtask parts render as collapsible sections. Child
session transcripts are navigable. Links from parent subtask to child session
work.

**Steps 10-11 — Interruption**: Partial response exists. Cancelled state is
visible but not jarring.

**Step 12-13 — Questions**: Question renders with options and the user's
selected answer. Resolved state is clearly shown.

**Steps 14-15 — Sandbox**: Blocked/denied operations render appropriate
error or denial UI.

**Step 16, 23 — Todos**: Todos render as a checklist with correct statuses
(pending, completed).

**Steps 18-19 — Compaction**: Compaction markers render appropriately (not
as raw JSON). Post-compaction transcript is coherent.

**Steps 20-22 — Persistence**: After reopen, all prior messages still present.
Message count matches pre-close count.

**Steps 25-26 — Multi-Permission**: Multiple permission prompts visible
simultaneously. Each resolved independently.

**Steps 31-33 — Background Tasks**: Running background tasks show a spinner
or running indicator. Completed tasks show output.

**Step 34 — Summary**: Full summary renders as formatted text. This is the
capstone — if the UI holds together through all 34 steps, Level 3 passes.
