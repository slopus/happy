# Agent SDK Upgrade + Plan Mode Fix + Integration Tests

## Context

Plan mode buttons (accept/reject) don't reliably appear in the Happy app UI. Root cause: the CLI's `permissionHandler.handleToolCall` auto-approves ExitPlanMode when `permissionMode` is stale (`bypassPermissions` from a prior session), and `reset()` never clears `permissionMode`. Additionally, `isAborted` always returns true for ExitPlanMode as part of a PLAN_FAKE_RESTART hack, which causes a dead-end when the tool is auto-approved without injecting a restart message.

The current custom SDK (`src/claude/sdk/`) reimplements what `@anthropic-ai/claude-agent-sdk` now provides natively, including `toolUseID` in `canUseTool` (eliminates our 1-second delay hack) and `setPermissionMode()` (eliminates the session-restart-on-mode-change hack).

### Control flow with the bug

```
[CLI] handleToolCall(ExitPlanMode, ...)
│
├─ permissionMode === 'bypassPermissions'?   ← stale from prior session
│  └─ YES → return allow ✅                  ← 🐛 skips permission UI
│
│  handlePermissionResponse NEVER called
│  └─ PLAN_FAKE_RESTART never injected
│
└─ isAborted(ExitPlanMode) → always true
   └─ claudeRemote exits → queue empty → stuck
```

### The fix (Part 1 — shipped)

ExitPlanMode now always goes through the permission request flow, before the `bypassPermissions`/`acceptEdits` shortcuts:

```typescript
// permissionHandler.ts handleToolCall()
const descriptor = getToolDescriptor(toolName);

if (descriptor.exitPlan) {
    // Always ask — never auto-approve plan exit
    return this.handlePermissionRequest(toolCallId, toolName, input, options.signal);
}

if (this.permissionMode === 'bypassPermissions') { ... }  // other tools still bypass
```

---

## Part 1: Immediate Bug Fix ✅

**File:** `packages/happy-cli/src/claude/utils/permissionHandler.ts`

ExitPlanMode must never be auto-approved. In `handleToolCall`, check `descriptor.exitPlan` before the `bypassPermissions`/`acceptEdits` shortcuts and always route to `handlePermissionRequest`.

---

## Part 2: Agent SDK Migration

### 2a. Install dependency

```bash
cd packages/happy-cli && yarn add @anthropic-ai/claude-agent-sdk@^0.2.96
```

### 2b. Migrate SDK types

**File:** `src/claude/sdk/types.ts`

Replace custom types with re-exports from the Agent SDK:
- `SDKMessage` → from agent-sdk
- `CanCallToolCallback` → `CanUseTool` from agent-sdk (now receives `options.toolUseID`)
- `QueryOptions` → from agent-sdk `Options`
- `PermissionResult` → from agent-sdk
- Keep any Happy-specific extensions as wrappers

### 2c. Migrate query.ts

**File:** `src/claude/sdk/query.ts`

Replace our custom `Query` class + `query()` function with the Agent SDK's `query()`:
- The Agent SDK's `query()` returns a `Query` that is `AsyncGenerator<SDKMessage>` with control methods
- It handles process spawning, stdin/stdout, control requests internally
- Our `handleControlRequest` / `processControlRequest` / `cleanupControllers` all become unnecessary

Key mapping:
| Current (custom) | Agent SDK |
|---|---|
| `canCallTool: (name, input, opts) => ...` | `canUseTool: (name, input, opts) => ...` |
| opts has `{ signal }` | opts has `{ signal, toolUseID, suggestions, title, ... }` |
| Manual `--permission-prompt-tool stdio` arg | Handled automatically when `canUseTool` provided |

### 2d. Use toolUseID from canUseTool

**File:** `src/claude/utils/permissionHandler.ts`

The `canUseTool` callback now receives `options.toolUseID`. Remove:
- `resolveToolCallId()` method and the 1-second delay retry hack
- `toolCalls[]` tracking array
- `onMessage()` method (no longer needed for tool ID resolution)

### 2e. Use setPermissionMode for mode changes

**File:** `src/claude/claudeRemote.ts`

Store the `Query` object so we can call `query.setPermissionMode()` when mode changes arrive, instead of killing and restarting the session.

**File:** `src/claude/claudeRemoteLauncher.ts`

When a permission mode change is detected in `nextMessage()`:
- Instead of returning null (triggering restart), call `query.setPermissionMode(newMode)`
- Update `permissionHandler.handleModeChange()` as before
- Continue processing — no restart needed

**Caveat:** Model changes still require restart (different `--model` flag). Keep hash-based detection for model changes only.

---

## Part 3: Plan Mode Hack Cleanup

Depends on Part 2 being complete.

### 3a. Remove PLAN_FAKE_RESTART / PLAN_FAKE_REJECT

**File:** `src/claude/sdk/prompts.ts` — delete entirely

**File:** `src/claude/utils/permissionHandler.ts` — in `handlePermissionResponse`:
- When plan approved: call `setPermissionMode(approvedMode)` on the query, then return `{ behavior: 'allow' }`
- When plan denied: return `{ behavior: 'deny', message: reason }`
- No more fake messages, no more queue injection

### 3b. Remove isAborted always-true for ExitPlanMode

**File:** `src/claude/utils/permissionHandler.ts` — in `isAborted()`:
- Remove the special case for exit_plan_mode
- Only return true when `responses.get(toolCallId)?.approved === false`

### 3c. Remove tool result content transformation

**File:** `src/claude/claudeRemoteLauncher.ts` — remove the PLAN_FAKE_REJECT → "Plan approved" transformation in `onMessage()` (lines 196-224)

### 3d. Remove planModeToolCalls tracking

**File:** `src/claude/claudeRemoteLauncher.ts` — remove `planModeToolCalls` Set and detection logic

---

## Part 4: Integration Tests ✅

**File:** `src/claude/planMode.integration.test.ts`

Three tests against an isolated `/tmp/happy-testing-ground-<random>/` fixture with `hello-world.js` in a git repo:

1. **Plan approval** → ExitPlanMode received by canCallTool, plan input has content, Claude edits the file
2. **Plan denial** → file untouched after deny
3. **Regression** → ExitPlanMode always reaches canCallTool (the bug we found)

**File:** `src/testing/planModeTestFixture.ts` — creates the isolated fixture

**File:** `vitest.config.ts` — new `integration-plan-mode` project with 180s timeout

---

## Hacks inventory (to remove in Parts 2-3)

| Hack | Location | Why it exists | SDK replacement |
|------|----------|--------------|----------------|
| `PLAN_FAKE_RESTART` / `PLAN_FAKE_REJECT` | `sdk/prompts.ts`, `permissionHandler.ts`, `claudeRemoteLauncher.ts` | SDK doesn't support plan mode exit natively | `setPermissionMode()` + allow/deny |
| `resolveToolCallId` + 1s delay | `permissionHandler.ts:156-163` | Race between permission request and message processing | `toolUseID` in `canUseTool` options |
| `isAborted` always-true for ExitPlanMode | `permissionHandler.ts:342-346` | Prevents SDK from executing the fake-rejected tool | Not needed when approval is real |
| Tool result content transformation | `claudeRemoteLauncher.ts:196-224` | Converts PLAN_FAKE_REJECT to "Plan approved" for logs | Not needed when flow is clean |
| Hash-based mode change → kill session → restart | `claudeRemoteLauncher.ts:372-378` | SDK doesn't restart on mode change | `setPermissionMode()` mid-session |

---

## Files modified (summary)

| File | Change |
|---|---|
| `package.json` | Add `@anthropic-ai/claude-agent-sdk` dependency |
| `src/claude/sdk/types.ts` | Re-export Agent SDK types |
| `src/claude/sdk/query.ts` | Replace with Agent SDK wrapper |
| `src/claude/sdk/prompts.ts` | Delete (PLAN_FAKE constants) |
| `src/claude/sdk/index.ts` | Update exports |
| `src/claude/utils/permissionHandler.ts` | Fix bug, use toolUseID, remove hacks |
| `src/claude/utils/getToolDescriptor.ts` | No change (already correct) |
| `src/claude/claudeRemote.ts` | Use setPermissionMode, store query ref |
| `src/claude/claudeRemoteLauncher.ts` | Remove plan mode hacks, simplify mode changes |
| `src/claude/planMode.integration.test.ts` | New — plan mode tests |
| `src/testing/planModeTestFixture.ts` | New — test fixture helper |
| `vitest.config.ts` | Add plan mode test suite |
