# Reliable HTTP Messages API (v3)

## Overview
Replace Socket.IO-based message read/write with simple HTTP endpoints optimized for CLI usage. The new v3 API provides:
- **Cursor-based message reading** using the existing `seq` field — fetch from start, then poll for new messages after last known seq
- **Batch message sending** — CLI buffers messages locally and sends them in a single HTTP POST
- **Guaranteed order** — seq is allocated atomically per session, messages always returned in seq order
- **Reliable delivery** — no messages lost; client can always catch up by polling with last known seq

This is server-side only. CLI client migration will happen separately. Existing Socket.IO message flow remains fully functional (backward compatibility). The plan is to replace Socket.IO with SSE later.

## Context (from discovery)
- **Message storage**: `SessionMessage` table with per-session `seq` (allocated via `allocateSessionSeq` in `storage/seq.ts`)
- **Deduplication**: `localId` field with `@@unique([sessionId, localId])` constraint
- **Current read endpoint**: `GET /v1/sessions/:id/messages` — limited to 150, no cursor, ordered by `createdAt desc`
- **Current write**: Socket.IO `message` event in `socket/sessionUpdateHandler.ts` — single message at a time with `AsyncLock`
- **Event broadcasting**: `eventRouter.emitUpdate()` sends `new-message` updates to Socket.IO clients
- **Existing cursor pattern**: `GET /v2/sessions` uses ID-based cursor — we'll follow a similar pattern but use `seq`
- **Existing batch pattern**: KV store `POST /v1/kv` does atomic batch mutations — good reference

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Maintain backward compatibility with existing Socket.IO message flow

## API Design

### Read Messages: `GET /v3/sessions/:sessionId/messages`

**Query Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `after_seq` | number | 0 | Return messages with seq > after_seq |
| `limit` | number | 100 | Max messages to return (1-500) |

**Response:**
```json
{
  "messages": [
    {
      "id": "cuid",
      "seq": 1,
      "content": { "t": "encrypted", "c": "base64..." },
      "localId": "optional-dedup-id",
      "createdAt": 1234567890,
      "updatedAt": 1234567890
    }
  ],
  "hasMore": true
}
```

**Behavior:**
- Messages ordered by `seq ASC` (oldest first, natural reading order)
- Client stores the highest `seq` received, polls with `after_seq=<lastSeq>` to get new messages
- `hasMore=true` means there are more messages beyond the returned batch — fetch again with `after_seq` set to last message's seq
- Initial load: `after_seq=0` fetches from the very beginning
- Catch-up: `after_seq=<lastKnownSeq>` fetches only new messages
- Uses existing index `@@index([sessionId, seq])` for efficient queries

### Send Messages: `POST /v3/sessions/:sessionId/messages`

**Request Body:**
```json
{
  "messages": [
    {
      "content": "base64-encrypted-content",
      "localId": "client-generated-dedup-id"
    }
  ]
}
```

**Constraints:**
- Max 100 messages per batch
- Each message must have a `localId` for deduplication
- `content` is the base64-encoded encrypted message (same format as Socket.IO `message` event)

**Response:**
```json
{
  "messages": [
    {
      "id": "cuid",
      "seq": 5,
      "localId": "client-dedup-id",
      "createdAt": 1234567890,
      "updatedAt": 1234567890
    }
  ]
}
```

**Behavior:**
- Messages are created atomically — all succeed or all fail
- `seq` numbers are allocated sequentially within the session
- Duplicate `localId` messages are skipped (idempotent) — their existing record is returned
- After persisting, emits `new-message` updates via Socket.IO eventRouter for backward compatibility
- Returns all messages (including deduplicated ones) with their seq numbers

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix

## Implementation Steps

### Task 1: Add cursor-based message read endpoint
- [x] Create `GET /v3/sessions/:sessionId/messages` route in a new `v3SessionRoutes.ts` file
- [x] Add Zod schema for query params: `after_seq` (number, default 0), `limit` (number, 1-500, default 100)
- [x] Verify session belongs to authenticated user (same pattern as v1)
- [x] Query `SessionMessage` where `sessionId` and `seq > after_seq`, order by `seq ASC`, take `limit + 1`
- [x] Return messages array + `hasMore` boolean (based on whether limit+1 rows returned)
- [x] Register route in `api.ts`
- [x] Write tests for read endpoint: basic fetch, cursor pagination, empty session, limit bounds
- [x] Write tests for edge cases: invalid session, unauthorized access, after_seq beyond latest
- [x] Run tests — must pass before next task

### Task 2: Add batch message send endpoint
- [x] Add `POST /v3/sessions/:sessionId/messages` route in `v3SessionRoutes.ts`
- [x] Add Zod schema for body: `messages` array (max 100), each with `content` (string) and `localId` (string)
- [x] Verify session belongs to authenticated user
- [x] For each message in the batch: check if `localId` already exists (dedup), skip if so
- [x] Allocate seq numbers sequentially for new messages using `allocateSessionSeq`
- [x] Create all new messages in DB
- [x] Emit `new-message` updates via `eventRouter.emitUpdate()` for each new message (backward compat with Socket.IO clients)
- [x] Return all messages (new + deduplicated) with their seq/id/timestamps
- [x] Write tests for batch send: single message, multiple messages, deduplication via localId
- [x] Write tests for edge cases: empty batch, exceeds 100 limit, invalid session, partial dedup (some new, some existing)
- [x] Run tests — must pass before next task

### Task 3: Verify acceptance criteria
- [x] Verify cursor-based reading works end-to-end: fetch from seq 0, paginate, catch up
- [x] Verify batch sending works: messages get sequential seq numbers, dedup works
- [x] Verify backward compatibility: sent messages trigger Socket.IO `new-message` updates
- [x] Verify order guarantee: messages always returned in seq order
- [ ] Run full test suite
- [ ] Run linter — all issues must be fixed

⚠️ Full package test suite currently fails on an existing unrelated fixture issue: `sources/storage/processImage.spec.ts` expects `sources/storage/__testdata__/image.jpg` which is missing in this workspace.
⚠️ No lint script is defined in `packages/happy-server/package.json`, so linter execution is currently not available.

## Technical Details

### Seq Allocation for Batches
The existing `allocateSessionSeq` increments by 1. For batch sends, we need N sequential seq numbers. Two options:
1. **Call `allocateSessionSeq` N times** — simple, uses existing code, but N DB roundtrips
2. **New `allocateSessionSeqBatch(sessionId, count)` function** — single `UPDATE sessions SET seq = seq + N` returning the new seq, then assign `(newSeq - N + 1)` through `newSeq`

Option 2 is preferred — single DB roundtrip regardless of batch size.

### Deduplication Strategy
For batch sends with mixed new/existing messages:
1. Query all existing messages with matching `localId` values in a single query
2. Filter out already-existing messages
3. Only create new messages and allocate seq for them
4. Return combined results (existing + newly created) sorted by seq

### Database Index Usage
- Read endpoint uses existing `@@index([sessionId, seq])` — efficient range scan
- Dedup lookup uses existing `@@unique([sessionId, localId])` — efficient point lookups

## Post-Completion

**CLI Migration (separate effort):**
- Update `happy-agent` to use `POST /v3/sessions/:id/messages` instead of Socket.IO `message` event
- Update `happy-agent` to poll `GET /v3/sessions/:id/messages` for receiving messages
- Eventually replace polling with SSE for real-time delivery

**SSE Migration (future):**
- Add `GET /v3/sessions/:id/messages/stream` SSE endpoint
- Client connects with `Last-Event-ID` = last seq for catch-up
- Replaces polling for real-time message delivery
