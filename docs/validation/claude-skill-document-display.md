# Claude Skill document reads

Claude can load a Skill through a native `Skill` call or read its `SKILL.md`
with `Read`. Previously only the native call produced an activity entry.
The client now recognizes historical document reads without changing stored
messages, tool types, file details, or execution workers.

## Acceptance

| Case | Expected behavior | Evidence |
| --- | --- | --- |
| C1 | `Read(.../<name>/SKILL.md)` shows a Skill instruction load, with load-specific status; repeated reads share a row. | `skillDocumentRead.test.ts`, `ConversationActivityStrip.skillRead.test.tsx` |
| C2 | Native invocation of the same Skill retains its own identity and status. Ordinary files, edits and ambiguous paths do not become Skill loads. | `skillDocumentRead.test.ts` |
| C3 | Standalone reads retain the original tool details and navigation. Group suppression does not remove the tool. Pending permissions remain actionable and do not claim loading has started. | `MessageView.skillRead.test.tsx` |
| C4 | Tool grouping, native Skill diagnostics and browser evidence remain compatible. | Existing activity, MessageView, ToolGroupView, transcript and browser-step regressions |

Instruction loading does not assert that the Skill's business task was executed
or completed. A successful read can be partial when the caller supplied a range.
The activity describes that read operation only.

## Local validation

- 147 tests passed across 11 targeted files, including 48 new regression cases
  and the Android runtime contract.
- `happy-app` TypeScript typecheck and `git diff --check` are required before
  publishing.
- Independent review identified the standalone Read navigation regression;
  the final implementation preserves `ToolView` and adds the activity alongside it.
- No new routes, input interactions, persistence or native configuration. A
  separate automated browser E2E/video suite is unnecessary for this derived
  history display change. Verify the original production conversation after CI
  activation, including its early document reads and later native Skill call.

## Release boundary

Use the existing main CI for production Web and applicable OTA artifacts.
No CLI restart or new APK is needed. Deployment receipts and current-device
observations belong to the task's private Release OPS record; unit tests do not
substitute for production-page or phone-loading evidence.
