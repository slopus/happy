# Sync & Message Architecture

This document explains how Arc synchronizes data with Claude Code CLI and processes messages for display.

## Overview

Arc receives real-time updates from Claude Code sessions via WebSocket. Messages flow through multiple normalization layers before reaching the UI, handling API differences across providers (Claude, Codex, Gemini) and ensuring deduplication.

```
Claude Code CLI
    │ WebSocket
    ▼
Socket.io Server (/v1/updates)
    │ Encrypted ApiUpdate[]
    ▼
sync.subscribeToUpdates()
    │ Decrypt
    ▼
RawRecord (API format)
    │ normalizeRawMessage()
    ▼
NormalizedMessage
    │ reducer.process()
    ▼
Message (UI model)
    │ Zustand subscription
    ▼
ChatList → MessageView → UI
```

## Normalization Layers

### Layer 1: Raw API Types (`typesRaw.ts`)

The first layer handles the raw JSON from Claude Code CLI. Different agent providers send messages in different formats:

| Provider | Tool Call Format | Tool Result Format |
|----------|------------------|-------------------|
| Claude | `type: 'tool_use'` | `type: 'tool_result'` |
| Codex | `type: 'tool-call'` | `type: 'tool-call-result'` |
| Gemini | `type: 'tool-call'` | `type: 'tool-call-result'` |

**Key Schema Types:**

```typescript
// Raw content from Claude API
RawAgentContent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'tool-call'; callId: string; name: string; input: any }      // Codex/Gemini
  | { type: 'tool-call-result'; callId: string; output: any }            // Codex/Gemini

// Wrapped in agent records
RawAgentRecord =
  | { type: 'output'; data: { type: 'assistant'; message: {...} } }
  | { type: 'output'; data: { type: 'user'; message: {...} } }
  | { type: 'event'; id: string; data: AgentEvent }
  | { type: 'codex'; data: {...} }
  | { type: 'acp'; provider: 'gemini'|'codex'|'claude'; data: {...} }

// Top-level record discriminated by role
RawRecord =
  | { role: 'agent'; content: RawAgentRecord }
  | { role: 'user'; content: { type: 'text'; text: string } }
```

**Zod Preprocessing:**

Before validation, a preprocessor normalizes hyphenated formats to canonical:

```typescript
// Input (Codex format)
{ type: 'tool-call', callId: 'abc', name: 'Bash', input: {...} }

// After preprocessing (canonical format)
{ type: 'tool_use', id: 'abc', name: 'Bash', input: {...} }
```

This uses `z.preprocess()` to avoid Zod v4's "unmergable intersection" issues with transforms inside complex schemas.

**Why `.passthrough()`:**

All schemas use `.passthrough()` to preserve unknown fields:
- Future API compatibility (new fields don't break validation)
- CLI metadata fields (timestamp, requestId, version) flow through
- Enables graceful degradation for unknown content types

### Layer 2: Normalized Types (still in `typesRaw.ts`)

After Zod validation, messages are transformed into a cleaner intermediate format:

```typescript
NormalizedAgentContent =
  | { type: 'text'; text: string; uuid: string; parentUUID: string | null }
  | { type: 'thinking'; thinking: string; uuid: string; parentUUID: string | null }
  | { type: 'tool_use'; id: string; name: string; input: any; uuid: string; ... }
  | { type: 'tool_result'; tool_use_id: string; content: string; ... }

NormalizedMessage = {
  messageId: string;      // Unique ID for deduplication
  uuid: string;           // Optional tracer UUID
  parentUuid: string;     // For sidechain linking
  role: 'agent' | 'user';
  content: NormalizedAgentContent[];
  meta?: MessageMeta;
}
```

**Key transformations:**
- Extract UUIDs for message linking
- Flatten nested message structures
- Normalize permission data format
- Add computed fields (descriptions, timestamps)

### Layer 3: UI Message Types (`typesMessage.ts`)

The final layer is a flat, UI-friendly structure:

```typescript
type Message =
  | UserTextMessage     // kind: 'user-text'
  | AgentTextMessage    // kind: 'agent-text'
  | ToolCallMessage     // kind: 'tool-call'
  | ModeSwitchMessage   // kind: 'agent-event'

// Tool calls include children for nested conversations
type ToolCallMessage = {
  kind: 'tool-call';
  id: string;
  createdAt: number;
  tool: ToolCall;
  children: Message[];  // Sidechain messages
}

type ToolCall = {
  name: string;
  state: 'running' | 'completed' | 'error';
  input: any;
  result?: any;
  permission?: {
    id: string;
    status: 'pending' | 'approved' | 'denied' | 'canceled';
    mode?: string;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
  };
}
```

## Message Reducer (`reducer/reducer.ts`)

The reducer is the core processing engine that transforms normalized messages into the final UI model. It handles deduplication, tool permission matching, and sidechain organization.

### Processing Phases

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Reducer Processing Pipeline                        │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  Phase 0: AgentState Permissions                                          │
│  ├── Process pending permission requests                                  │
│  ├── Create placeholder tool messages for permissions                     │
│  └── Skip if matching tool call exists in incoming messages              │
│                                                                           │
│  Phase 0.5: Message-to-Event Conversion                                  │
│  ├── Check if messages should become events                              │
│  ├── Parse user commands (e.g., /mode switch)                            │
│  └── Convert and skip remaining phases                                   │
│                                                                           │
│  Phase 1: User and Text Messages                                          │
│  ├── Process user messages with localId deduplication                    │
│  ├── Process agent text messages                                          │
│  └── Skip tool calls for later phases                                    │
│                                                                           │
│  Phase 2: Tool Calls                                                      │
│  ├── Match to existing permission messages (name + arguments)            │
│  ├── Prioritize newest matching permission                               │
│  └── Create new tool message if no match                                 │
│                                                                           │
│  Phase 3: Tool Results                                                    │
│  ├── Find tool message by tool_use_id                                    │
│  ├── Update state: running → completed/error                             │
│  └── Attach result content                                               │
│                                                                           │
│  Phase 4: Sidechains                                                      │
│  ├── Identify sidechain messages via parentUuid                          │
│  ├── Store separately, linked to parent tool                             │
│  └── Handle nested tool calls within sidechains                          │
│                                                                           │
│  Phase 5: Mode Switch Events                                              │
│  ├── Process agent events (switch, limit-reached, ready)                 │
│  └── Convert to ModeSwitchMessage                                        │
│                                                                           │
└─────────────────────────────────────────────────────────────────────────┘
```

### Deduplication Mechanisms

The reducer maintains state to prevent duplicate messages:

```typescript
type ReducerState = {
  // Track processed message IDs
  messageIdSet: Set<string>;

  // Track user message local IDs (for optimistic updates)
  localIdSet: Set<string>;

  // Map tool IDs to message IDs (for permission matching)
  toolIdToMessageId: Map<string, string>;

  // Track processed permission IDs
  permissionIdSet: Set<string>;

  // Sidechain storage
  sidechainMessages: Map<string, Message[]>;
}
```

### Permission Matching Algorithm

When a tool call arrives:

1. Check if tool ID already processed (`toolIdToMessageId`)
2. Search for approved permission with:
   - Same tool name
   - Matching arguments (deep equality)
   - Not already linked to another tool
3. Prioritize newest matching permission
4. Update permission message with execution details
5. Fall back to creating new tool message if no match

```
Permission arrives first:
┌─────────────────────┐     ┌─────────────────────┐
│ Permission Request  │ ──▶ │ Placeholder Message │
│ name: "Bash"        │     │ state: "running"    │
│ status: "pending"   │     │ permission.pending  │
└─────────────────────┘     └─────────────────────┘
                                      │
                                      ▼ (user approves)
┌─────────────────────┐     ┌─────────────────────┐
│ Tool Call arrives   │ ──▶ │ Update existing msg │
│ name: "Bash"        │     │ state: "running"    │
│ id: "tool_abc"      │     │ permission.approved │
└─────────────────────┘     └─────────────────────┘
                                      │
                                      ▼
┌─────────────────────┐     ┌─────────────────────┐
│ Tool Result         │ ──▶ │ Final message       │
│ tool_use_id: "abc"  │     │ state: "completed"  │
│ content: "..."      │     │ result: "..."       │
└─────────────────────┘     └─────────────────────┘
```

### Key Behaviors

- **Idempotency**: Same data processed multiple times = no duplicates
- **Priority**: Tool calls take priority over permission messages
- **Timestamp Preservation**: Original timestamps never modified
- **Message Immutability**: Only tool state/result can change, not core properties

## Real-Time Updates (`apiSocket.ts`)

### Connection Setup

```typescript
// Socket.io configuration
const socket = io(serverUrl, {
  path: '/v1/updates',
  transports: ['websocket'],
  auth: { token: bearerToken, clientType: 'user-scoped' },
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});
```

### Update Types

```typescript
type ApiUpdate =
  // Persistent updates (stored)
  | { type: 'new-message'; sessionId: string; message: EncryptedMessage }
  | { type: 'new-session'; session: Session }
  | { type: 'delete-session'; sessionId: string }
  | { type: 'update-session'; sessionId: string; agentState?: AgentState; metadata?: Metadata }
  | { type: 'update-machine'; machineId: string; metadata: MachineMetadata }
  | { type: 'new-artifact' | 'update-artifact' | 'delete-artifact'; ... }

  // Ephemeral updates (not stored)
  | { type: 'activity'; sessionId: string; active: boolean; thinking: boolean }
  | { type: 'usage'; sessionId: string; usage: UsageData }
  | { type: 'machine-activity'; machineId: string; online: boolean }
```

### Encryption

All messages are encrypted per-session:

```typescript
// Decrypt incoming message
const decrypted = await encryption.decryptMessage(
  sessionId,
  encryptedMessage.data,
  encryptedMessage.nonce
);

// Parse and validate
const raw = JSON.parse(decrypted);
const validated = RawRecordSchema.parse(raw);
const normalized = normalizeRawMessage(validated, messageId);
```

## State Management (`storage.ts`)

### Zustand Store

```typescript
type StorageState = {
  // Session data
  sessions: Record<string, Session>;
  sessionMessages: Record<string, {
    messages: Message[];
    messagesMap: Record<string, Message>;
    reducerState: ReducerState;
    isLoaded: boolean;
  }>;

  // Connection status
  socketStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
  realtimeStatus: 'disconnected' | 'connecting' | 'connected' | 'error';

  // Other state
  machines: Record<string, Machine>;
  artifacts: Record<string, Artifact>;
}
```

### Subscription Hooks

```typescript
// Session data
useSession(sessionId): Session | null
useSessionMessages(sessionId): Message[]
useAllSessions(): Session[]

// Connection status
useSocketStatus(): SocketStatus
useRealtimeStatus(): RealtimeStatus

// Settings
useSetting(key): T
useLocalSetting(key): T
```

## Session Data Model

### Session Type

```typescript
type Session = {
  id: string;
  seq: number;                    // Sequence number for ordering
  createdAt: number;
  updatedAt: number;
  active: boolean;
  activeAt: number;

  // From CLI
  metadata: {
    path: string;                 // Working directory
    host: string;                 // Machine hostname
    version: string;              // CLI version
    machineId: string;            // For avatar generation
    flavor?: 'gemini' | 'codex';  // Agent provider
    summary?: {
      name: string;               // Display name
      updatedAt: number;
    };
  } | null;

  // Permission state
  agentState: {
    pending: PermissionRequest[];
    completed: CompletedPermission[];
  } | null;

  // Real-time state
  presence: 'online' | number;    // "online" or last-seen timestamp
  thinking: boolean;
  thinkingAt: number;

  // Local state (not synced)
  draft?: string;
  permissionMode?: string;
  todos?: Todo[];
}
```

### Metadata Sync

Session metadata comes from two sources:

1. **Initial connect**: CLI sends metadata with session creation
2. **Continuous updates**: CLI pushes summary updates via `update-session`

```
CLI starts
    │
    ▼
new-session { metadata: { path, host, version } }
    │
    ▼
(user interaction)
    │
    ▼
update-session { metadata: { summary: { name, updatedAt } } }
```

## Persistence (`persistence.ts`)

Local storage uses MMKV (fast key-value store):

```typescript
// Persisted data
- Settings + schema version
- Session drafts (per-session text)
- Permission modes (per-session)
- Purchase state
- Profile data
- Local preferences

// Not persisted (in-memory only)
- Message history (re-fetched on launch)
- Socket state
- Ephemeral activity updates
```

## File Reference

| File | Purpose |
|------|---------|
| `sync/typesRaw.ts` | Raw API schemas, Zod validation, normalization |
| `sync/typesMessage.ts` | UI message types (flat structure) |
| `sync/typesMessageMeta.ts` | Message metadata schemas |
| `sync/storageTypes.ts` | Session, Machine, Artifact types |
| `sync/storage.ts` | Zustand store, hooks, message application |
| `sync/apiSocket.ts` | Socket.io client, RPC layer |
| `sync/apiTypes.ts` | API update type definitions |
| `sync/sync.ts` | Main sync orchestrator |
| `sync/reducer/reducer.ts` | Message processing, deduplication |
| `sync/persistence.ts` | MMKV storage layer |
| `sync/encryption.ts` | Per-session encryption |
