# Task card conversation selection

2026-11-18. Scope: desktop project task card selection. Mobile navigation is unchanged.

The card body previously cleared the conversation while selecting another task. Clicking the selected card toggled into global chat or deselected the task, changing the catalog width and remounting the workspace.

Desktop selection now resolves the latest existing task conversation from task-scoped history and live ownership, then navigates with task and conversation in one update. Unknown history is read on demand before navigating, following advancing history cursors until an available conversation is found or history is exhausted; failure preserves the current layout and reports the error. Selecting the current open task does nothing. Explicit chat creation and close/global controls retain their own actions. No conversation is created by card selection.

Pending clicks are coalesced. A newer selection, context change or unmount invalidates older results. Task history ownership, deleted session filtering and latest-conversation selection reuse existing helpers. Resolved history is cached before mounting the selected task.

Validation: 33 tests passed across useTaskCardSelection, useProjectNavigation, ProjectWorkspaceWidth, projectWorkspaceLayout, useProjectConversation mergeProjectTaskHistory and taskCardHistory. Pagination regression covers unavailable first-page entries, early success, exhaustion, lookup failure and repeated-cursor rejection. TypeScript check passed. No browser visual verification or deployment performed. Screenshot request was sent; no reply was received during implementation, so no screenshots were captured. Desktop behavior cannot be validated through Android OTA; no mobile UI behavior changes or native changes are included.
