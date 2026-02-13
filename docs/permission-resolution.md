# Permission Resolution (State-Based)

This document explains how permission mode is resolved for session messages, depending on current state in the app and CLI.

## Scope
- App-side state resolution (session defaults, persisted values, outbound message metadata)
- Claude CLI resolution (startup mode, per-message updates, sandbox policy)
- Final mode sent to Claude SDK

## Permission Modes
- Shared mode type: `default | acceptEdits | bypassPermissions | plan | read-only | safe-yolo | yolo`
- Claude SDK supports: `default | acceptEdits | bypassPermissions | plan`
- Mapping to Claude happens in `packages/happy-cli/src/claude/utils/permissionMode.ts`:
  - `yolo -> bypassPermissions`
  - `safe-yolo -> default`
  - `read-only -> default`

## App-Side Resolution

### 1) Session state load/merge
`packages/happy-app/sources/sync/storage.ts`

When sessions are merged, the app resolves `session.permissionMode` using this order:
1. Existing in-memory session mode (if non-`default`)
2. Persisted per-session mode from local storage (if non-`default`)
3. Mode from server session payload (if non-`default`)
4. Sandbox fallback:
   - If `session.metadata.sandbox.enabled === true`: `bypassPermissions`
   - Otherwise: `default`

### 2) New-session draft fallback
`packages/happy-app/sources/sync/persistence.ts`

If draft permission mode is missing:
- Draft default: `default`

### 3) New session UI defaults
`packages/happy-app/sources/app/(app)/new/index.tsx`
`packages/happy-app/sources/components/NewSessionWizard.tsx`

Default selection:
- `default`

If selected mode is invalid for the currently selected agent, UI resets to agent default above.

### 4) Outbound message mode
`packages/happy-app/sources/sync/sync.ts`

On send:
- If `session.permissionMode` is non-`default`, send it.
- Otherwise:
  - If `session.metadata.sandbox.enabled === true`: send `bypassPermissions`
  - Else send `default`

This value is sent in:
- encrypted message `meta.permissionMode`
- socket envelope `permissionMode`

## Claude CLI Resolution

### 1) Startup resolution
`packages/happy-cli/src/claude/runClaude.ts`
`packages/happy-cli/src/claude/utils/permissionMode.ts`

Initial mode comes from:
1. `--dangerously-skip-permissions` (highest priority) -> `bypassPermissions`
2. `--permission-mode VALUE` or `--permission-mode=VALUE`
3. Provided `options.permissionMode`

Then sandbox policy is applied:
- If sandbox enabled: force `bypassPermissions`
- If sandbox disabled: keep resolved mode

### 2) Per-message updates in remote flow
`packages/happy-cli/src/claude/runClaude.ts`

When a user message includes `meta.permissionMode`:
- If sandbox enabled: forced to `bypassPermissions`
- If sandbox disabled: use incoming mode

### 3) Local Claude process
`packages/happy-cli/src/claude/claudeLocal.ts`

If sandbox is enabled, launcher appends `--dangerously-skip-permissions` before spawn.

## Effective Result Matrix

### Sandbox enabled
- App fallback mode is `bypassPermissions` when session mode is default/missing
- Claude CLI sandbox policy still forces `bypassPermissions` in remote flow

### Sandbox disabled
- If app/session mode is non-`default`: that mode is used
- If app/session mode is `default` or missing:
  - App sends `default`
  - CLI uses normal mode resolution (no sandbox forcing)

## Why this is stable now
- Client fallback only forces skip-permissions for sandboxed sessions.
- CLI sandbox policy guarantees sandboxed Claude sessions cannot re-enable permission prompts via message metadata.
