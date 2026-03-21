# Provider Envelope Testing — Wire v3 E2E and Prove It

Status: **PLAN**
Depends on: `provider-envelope-redesign.md`
Branch: `messaging-protocol-v3`

## Context

We built v3 types, mappers for Claude and Codex, an app converter, and 63
unit tests. None of it is wired into real code paths. The unit tests pass
pre-built payloads through isolated functions — they don't prove anything
works end-to-end with a real provider sending real messages through real
encryption.

This plan wires the gaps and proves it with real per-provider integration
tests that boot environments, spawn real sessions against lab-rat-todo-project,
and exercise the flow from `environments/lab-rat-todo-project/exercise-flow.md`.

## What's broken (the gaps)

1. **Claude permissionHandler** never calls `blockToolForPermission` /
   `unblockToolApproved` / `unblockToolRejected` on the v3 mapper.
   Tool parts stay `running` when they should go `blocked`.

2. **Codex event handler** in `runCodex.ts` never calls `handleCodexEvent`
   from the v3 Codex mapper. The mapper exists but isn't invoked.

3. **App decrypt pipeline** in `sync.ts` never calls `isV3Envelope` /
   `convertV3ToAppMessages`. The functions exist but decrypted messages
   always go through the legacy `normalizeRawMessage` path.

4. **happy-agent** has no way to approve/deny permissions. Can't test
   permission flows without it.

5. **No real integration tests** — existing tests (`claude.integration.test.ts`
   etc.) test the v1 path only. Our v3 "integration test" passes hand-built
   payloads, never touches a real provider.

---

## Phase 1: Add permission control to happy-agent

The app sends permission responses via `apiSocket.sessionRPC(sessionId,
'permission', { id, approved, ... })`. happy-agent's SessionClient has the
same socket. We need to add the same capability.

### SessionClient additions (`packages/happy-agent/src/session.ts`)

```typescript
async sendRpc(method: string, params: unknown): Promise<unknown>
// Encrypts params, emits 'rpc-call' with method: `${sessionId}:${method}`
// Same mechanism as app's apiSocket.sessionRPC

async approvePermission(requestId: string, opts?: { mode?: string; allowTools?: string[] }): Promise<void>
// Calls sendRpc('permission', { id: requestId, approved: true, ... })

async denyPermission(requestId: string, opts?: { reason?: string }): Promise<void>
// Calls sendRpc('permission', { id: requestId, approved: false, ... })

getPendingPermissions(): Array<{ id: string; tool: string; arguments: unknown }>
// Reads agentState.requests

waitForPermission(timeoutMs?: number): Promise<{ id: string; tool: string }>
// Listens for state-change events until agentState.requests is non-empty
```

### CLI commands (`packages/happy-agent/src/index.ts`)

```
happy-agent permissions <session-id> [--json]
happy-agent approve <session-id> <request-id> [--mode ...] [--allow-tools ...]
happy-agent deny <session-id> <request-id> [--reason "..."]
```

---

## Phase 2: Wire the three code gaps

All behind `HAPPY_V3_PROTOCOL=1` env var. Zero change when flag is off.

### 2A. Claude permissions → v3 mapper

**Files:**
- `packages/happy-cli/src/api/apiSession.ts`
- `packages/happy-cli/src/claude/utils/permissionHandler.ts`

Add to apiSession:
```
blockToolForPermissionV3(callID, permission, patterns, metadata)
unblockToolApprovedV3(callID, decision)
unblockToolRejectedV3(callID, reason)
```
Each guarded by `HAPPY_V3_PROTOCOL`, delegates to v3Mapper functions, sends
updated message via `sendV3ProtocolMessage`.

Wire in permissionHandler:
- `handlePermissionRequest()` → `blockToolForPermissionV3`
- `handlePermissionResponse()` approved → `unblockToolApprovedV3`
- `handlePermissionResponse()` denied → `unblockToolRejectedV3`
- `reset()` → `unblockToolRejectedV3` per pending request

### 2B. Codex events → v3 mapper

**Files:**
- `packages/happy-cli/src/api/apiSession.ts`
- `packages/happy-cli/src/codex/runCodex.ts`

Add to apiSession:
```
sendCodexV3Event(event: Record<string, unknown>)
flushCodexV3Turn()
```

Wire in runCodex:
- Event handler: after v1 mapping, call `session.sendCodexV3Event(msg)`
- Turn boundaries: call `session.flushCodexV3Turn()`

### 2C. App decrypt → v3 converter

**Files:**
- `packages/happy-app/sources/sync/sync.ts`
- `packages/happy-app/sources/sync/storage.ts`

At both ingestion points (batch fetch + real-time update), before
`normalizeRawMessage`:

```typescript
if (isV3Envelope(decrypted.content)) {
    const appMsgs = convertV3ToAppMessages(decrypted.content);
    // inject into store bypassing reducer
    continue;
}
```

Add `applyDirectMessages(sessionId, messages)` to storage.ts for direct
message injection that skips the reducer.

---

## Phase 3: Per-provider integration tests

One test file per provider. Each follows exercise-flow.md steps
sequentially — one continuous session that builds on itself. Uses
happy-agent to spawn, send, approve, deny, read history, check files.

### `v3-claude.integration.test.ts`

Single session against lab-rat-todo-project. `HAPPY_V3_PROTOCOL=1`.
Default permissions (edit=ask).

```
describe('v3 Claude', { timeout: 600_000 })

  beforeAll:
    boot env (yarn env:up:authenticated)
    set HAPPY_V3_PROTOCOL=1 in daemon env
    spawn claude session against lab-rat-todo-project

  // ── TRANSCRIPT ──────────────────────────────────────

  it('step 1: orient — read files, text + tools')
    send "Read all files, tell me what this does"
    waitForIdle
    read history → find v3 envelopes
    assert: assistant message with text parts
    assert: tool parts (Read) with status: completed
    assert: step-start + step-finish
    assert: info.providerID === 'anthropic'

  it('step 2: find the bug — reasoning')
    send "There is a bug in the Done filter. Find it."
    waitForIdle
    assert: text mentions line 88 or !item.done

  // ── PERMISSIONS ─────────────────────────────────────

  it('step 3: edit rejected')
    send "Fix it."
    waitForPermission → get requestId
    denyPermission(requestId, { reason: 'show the diff first' })
    waitForIdle
    assert: tool part status: error, block.decision === 'reject'

  it('step 4: edit approved once')
    send "Ok apply the fix."
    waitForPermission → get requestId
    approvePermission(requestId)
    waitForIdle
    assert: tool part status: completed, block.decision === 'once'
    assert: app.js changed on disk

  it('step 5: approve always')
    send "Add dark mode to styles.css"
    waitForPermission → get requestId
    approvePermission(requestId, { allowTools: ['Edit', 'Write'] })
    waitForIdle
    assert: block.decision === 'always'

  it('step 6: auto-approved — no permission prompt')
    send "Add dark toggle button to index.html, wire in app.js"
    waitForIdle  // should NOT block
    assert: tool parts completed, NO block field

  // ── TOOLS ───────────────────────────────────────────

  it('step 9: simple edit')
    send "Add Cmd+Enter to submit from anywhere"
    // approve if blocked
    waitForIdle
    assert: tool completed, app.js changed

  // ── INTERRUPTION ────────────────────────────────────

  it('step 10: cancel mid-stream')
    send "Refactor all CSS into component files"
    sleep(2s)
    stop/interrupt
    assert: idle, in-flight tools cleaned up

  it('step 11: resume after cancel')
    send "Just add a comment to styles.css"
    waitForIdle
    assert: completed

  // ── PERSISTENCE ─────────────────────────────────────

  it('history survives — all steps present')
    read full history
    assert: v3 messages > 5
    assert: find rejected tool (step 3) with block.decision
    assert: find approved tool (step 4) with block.decision
    assert: find auto-approved tool (step 6) with no block

  it('dual write — v1 and v3 coexist')
    assert: history has BOTH role:'session' AND v:3

  afterAll: stop session
```

### `v3-codex.integration.test.ts`

Single session, `--agent codex`. Yolo for edits.

```
describe('v3 Codex', { timeout: 600_000 })

  beforeAll:
    boot env, HAPPY_V3_PROTOCOL=1
    spawn codex session

  it('step 1: orient')
    send "Read all files, tell me what this does" --wait
    assert: v3 envelope with text parts

  it('step 2: find bug')
    send "There is a bug in the Done filter. Find it." --wait
    assert: text mentions the bug

  it('step 9: edit with yolo')
    send "Add comment '// codex v3 test' to top of app.js" --yolo --wait
    assert: tool part completed, app.js changed on disk

  it('tool with output')
    send "Run: echo codex-v3-bash-test" --yolo --wait
    assert: tool part completed, output contains the string

  it('persistence — dual write')
    full history has BOTH v1 and v3 envelopes

  afterAll: stop session
```

---

## Phase 4: Cleanup

- Remove `environments/snapshots/` (empty, unused)
- `codex review --uncommitted` before every commit

---

## Implementation order

1. Add permission/RPC control to happy-agent (SessionClient + CLI)
2. Wire 2A: Claude permissions → v3 mapper
3. Wire 2B: Codex events → v3 mapper
4. Wire 2C: App decrypt → v3 converter
5. Write + run Claude integration test — iterate until green
6. Write + run Codex integration test — iterate until green
7. Full test suite, verify nothing broken
8. Cleanup

## Files to modify/create

| File | Change |
|------|--------|
| `packages/happy-agent/src/session.ts` | sendRpc, approve/deny, waitForPermission |
| `packages/happy-agent/src/index.ts` | approve/deny/permissions CLI commands |
| `packages/happy-cli/src/api/apiSession.ts` | v3 blocking + Codex v3 methods |
| `packages/happy-cli/src/claude/utils/permissionHandler.ts` | Call v3 blocking |
| `packages/happy-cli/src/codex/runCodex.ts` | Dual-write v3 |
| `packages/happy-app/sources/sync/sync.ts` | v3 detection at ingestion |
| `packages/happy-app/sources/sync/storage.ts` | applyDirectMessages |
| `packages/happy-agent/src/v3-claude.integration.test.ts` | **New** |
| `packages/happy-agent/src/v3-codex.integration.test.ts` | **New** |
| `environments/snapshots/` | Delete |
