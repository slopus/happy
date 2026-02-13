# CLI V3 Messages API Migration (happy-cli)

## Overview
Migrate `happy-cli`'s `ApiSessionClient` from Socket.IO-based message read/write to the new v3 HTTP endpoints. The client will:
- **Send messages** via `POST /v3/sessions/:sessionId/messages` using InvalidateSync to batch outgoing messages from an outbox — fixes the current problem where messages are silently lost on disconnect
- **Receive messages** via `GET /v3/sessions/:sessionId/messages?after_seq=X` with cursor-based polling, triggered by Socket.IO event invalidation
- **Track seq per session** — store `lastSeq` from server responses, use it for incremental fetches
- **Fast-path for consecutive events** — when a Socket.IO `new-message` event arrives with `seq === lastSeq + 1`, apply it directly. On gap, invalidate to trigger server fetch.

This replaces the current fire-and-forget `socket.emit('message', ...)` (5 separate send methods all using this pattern) and the direct Socket.IO `update` event handler for receiving.

## Context (from discovery)
- **Package**: `packages/happy-cli/src/api/apiSession.ts` — `ApiSessionClient` class (EventEmitter)
- **Current send methods** (all use `socket.emit('message', { sid, message: encrypted })`):
  - `sendClaudeSessionMessage(body)` — Claude JSONL output
  - `sendCodexMessage(body)` — Codex messages
  - `sendSessionProtocolMessage(envelope)` — Session protocol envelopes
  - `sendAgentMessage(provider, body)` — ACP unified format (Gemini, Codex, Claude, OpenCode)
  - `sendSessionEvent(event)` — Events (switch, message, permission-mode, ready)
- **Current receive**: Socket.IO `update` event → decrypt → parse as `UserMessage` → forward to `pendingMessageCallback` or buffer in `pendingMessages` array
- **Known bug**: Messages silently lost when socket disconnected (see TODO in `sendCodexMessage` line 275)
- **Encryption**: `encrypt(key, variant, data)` → Uint8Array → `encodeBase64()` → string (same format v3 POST expects as `content`)
- **HTTP client**: axios (not fetch) — used throughout the codebase
- **InvalidateSync**: Available in `src/utils/sync.ts` (identical to happy-app's version)
- **AsyncLock**: Available in `src/utils/lock.ts`
- **Tests**: vitest with mocked socket.io-client in `apiSession.test.ts`

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Maintain backward compatibility with Socket.IO for non-message events (metadata/agentState updates, RPC, keep-alive)

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- ⚠️ `npx eslint` in `packages/happy-cli` currently fails because there is no `eslint.config.(js|mjs|cjs)` in this workspace, so lint verification could not be completed.

## Implementation Steps

### Task 1: Migrate message sending to v3 POST via InvalidateSync
- [x] Add `pendingOutbox: Array<{ content: string, localId: string }>` to `ApiSessionClient` — encrypted messages waiting to be sent
- [x] Add `sendSync: InvalidateSync` to `ApiSessionClient` — triggers batch send, created in constructor
- [x] Create private `flushOutbox()` method: drain all pending messages, POST batch to `POST /v3/sessions/:sessionId/messages` via axios
- [x] Create private `enqueueMessage(content: any)` method: encrypt content → base64, generate `localId` (randomUUID), add to outbox, invalidate `sendSync`
- [x] Refactor all 5 send methods to call `enqueueMessage(content)` instead of `socket.emit('message', ...)`
- [x] Remove socket connection checks in send methods (outbox handles disconnection gracefully — messages wait until send succeeds)
- [x] Stop `sendSync` in `close()` method
- [x] Write tests for outbox: single message send, batch accumulation, retry on failure, outbox draining
- [x] Write tests for each send method: verify correct content structure is enqueued
- [x] Run tests — must pass before next task

### Task 2: Add seq tracking and cursor-based message fetch (receive path)
- [x] Add `lastSeq: number` field (initially 0) to `ApiSessionClient`
- [x] Add `receiveSync: InvalidateSync` to `ApiSessionClient` — triggers fetch from v3
- [x] Create private `fetchMessages()` method: GET `/v3/sessions/:sessionId/messages?after_seq=lastSeq&limit=100` via axios, loop while `hasMore`
- [x] In `fetchMessages`: decrypt each message, update `lastSeq` from highest seq in response
- [x] In `fetchMessages`: filter for `UserMessage` (role === 'user') and forward to `pendingMessageCallback` or buffer in `pendingMessages` — same as current behavior
- [x] Emit non-user messages as `'message'` event — same as current behavior
- [x] Write tests for fetchMessages: initial load (after_seq=0), incremental fetch, pagination with hasMore
- [x] Write tests for message routing: user messages → callback, other messages → event emitter
- [x] Run tests — must pass before next task

### Task 3: Update event handler for consecutive seq check (fast path)
- [x] In the `socket.on('update', ...)` handler for `new-message`: read `data.body.message.seq` from the update
- [x] Compare with `this.lastSeq` — if `seq === lastSeq + 1`, decrypt and apply directly (fast path), update lastSeq
- [x] If seq is not consecutive (gap detected), skip direct apply and invalidate `receiveSync` to trigger server fetch
- [x] If `lastSeq === 0` (no messages fetched yet), invalidate `receiveSync`
- [x] Keep existing `update-session` and `update-machine` handlers unchanged (they don't use messages API)
- [x] Write tests for fast-path: consecutive seq applies directly, gap triggers invalidate
- [x] Write tests for edge cases: first message (lastSeq=0), duplicate seq, stale seq
- [x] Run tests — must pass before next task

### Task 4: Update flushOutbox to track sent seq
- [x] In `flushOutbox()`, after successful POST, update `lastSeq` from the highest seq in the response
- [x] This ensures the CLI's own sent messages advance the seq cursor, so subsequent fetches don't re-fetch them
- [x] Write tests for seq advancement after send
- [x] Run tests — must pass before next task

### Task 5: Clean up and verify
- [x] Remove old `socket.emit('message', ...)` calls (all replaced by enqueueMessage)
- [x] Verify `flush()` method still works (it pings the socket, unrelated to message sending — may need to also await sendSync drain)
- [x] Verify `close()` properly stops sendSync and receiveSync
- [x] Verify reconnection behavior: on socket reconnect, receiveSync can be invalidated to catch up
- [x] Verify keepAlive, sendSessionDeath, sendUsageData, updateMetadata, updateAgentState still use Socket.IO (not migrated)
- [x] Run full test suite
- [ ] Run linter — all issues must be fixed

## Technical Details

### Message Outbox (Send)
```
pendingOutbox: Array<{ content: string, localId: string }>

enqueueMessage(rawContent):
  1. encrypted = encodeBase64(encrypt(key, variant, rawContent))
  2. localId = randomUUID()
  3. pendingOutbox.push({ content: encrypted, localId })
  4. sendSync.invalidate()

flushOutbox():
  1. batch = [...pendingOutbox]  // snapshot
  2. POST /v3/sessions/:sessionId/messages { messages: batch }
  3. On success: clear sent items from outbox, update lastSeq from response
  4. On failure: throw → InvalidateSync retries with backoff, messages stay in outbox
```

### Message Fetch (Receive)
```
fetchMessages():
  1. Loop:
     a. GET /v3/sessions/:sessionId/messages?after_seq=lastSeq&limit=100
     b. For each message: decrypt, route (user → callback, other → emit)
     c. Update lastSeq to max seq from response
     d. If !hasMore, break
```

### Fast-Path Decision Flow
```
new-message event arrives with msg.seq:
  1. if lastSeq > 0 AND msg.seq === lastSeq + 1:
     → decrypt + route directly, set lastSeq = msg.seq (fast path)
  2. else:
     → receiveSync.invalidate() → triggers fetchMessages
```

### What Stays on Socket.IO
- `session-alive` (keepAlive) — volatile, ephemeral
- `session-end` (sendSessionDeath) — lifecycle
- `usage-report` (sendUsageData) — analytics
- `update-metadata` / `update-state` — uses emitWithAck for optimistic concurrency
- `rpc-request` / `rpc-call` — bidirectional RPC
- `update` events for `update-session` / `update-machine` — metadata/state updates
- `ping` (flush) — connection check

## Post-Completion

**Future improvements:**
- Replace polling-based catch-up with SSE (`GET /v3/sessions/:id/messages/stream`)
- Remove Socket.IO dependency for messages entirely once SSE is in place
- Persist outbox to disk for crash recovery (messages survive CLI restart)
