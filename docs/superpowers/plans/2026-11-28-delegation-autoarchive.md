# Delegated worker automatic archive

**Goal:** Ordinary delegated children archive and release their executor after a confirmed terminal result; the parent retains the task and can explicitly request a revision.

**Architecture:** The coordinator persists a protected terminal receipt before requesting a binding-specific worker retirement RPC. Each revision starts a new child with the frozen role/model and a bounded snapshot of prior instructions/results. This rebuilds task context; it does not claim to restore native tool history. The parent and waiting/uncertain workers remain active.

**Constraints:** Keep the root clean main; use this sibling worktree. No polling, deletion, recursive delegation, executor/model fallback, new composer UI, or Tauri changes. Preserve request deduplication, ownership checks, durable results, and historical versions.

**Alternatives:** Keeping a hidden live child does not release resources. Native thread resume is available for Codex but not the current AGY adapter, so the consistent route is explicit context reconstruction in a fresh child.

## Steps

- [x] Add failing coordinator tests for terminal retirement after persistence, restart recovery, waiting/uncertain exclusions, new-child revisions, historical results, and late old-worker events.
- [x] Add a bounded revision-context formatter, per-version child identity, and event-driven retirement with reconnect/explicit-read retry.
- [x] Add a runtime adapter and bound native retirement handler that validate task, parent, PID, local input, terminal root, and no newer queued work at the effect boundary.
- [x] Run targeted coordinator/runtime/reporter/provider tests and CLI typecheck/build.
- [x] Obtain independent diff review; correct findings and update the delegation contract and verification record.
- [ ] Complete the normal PR/CI delivery and verify the installed runtime with a dedicated real task.

## Review focus

Archive must follow durable result persistence. An old completion/exit must not stop a new revision. Failed cleanup must not turn a completed task into a failure. Unknown delivery and waiting for input must not archive. Restored context must be bounded and clearly labeled as saved task data, with omissions explicit.
