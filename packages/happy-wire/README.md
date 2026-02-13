# @slopus/happy-wire

Canonical wire specification package for Happy clients and services.

This package defines shared wire contracts as TypeScript types + Zod schemas. It is intentionally small and focused on protocol-level data only.

## Quick Examples (Legacy vs New)

Both legacy and new formats are transported inside encrypted session messages.

Legacy format examples (decrypted payload):

```json
{
  "role": "user",
  "content": {
    "type": "text",
    "text": "fix the failing test"
  },
  "meta": {
    "sentFrom": "mobile"
  }
}
```

```json
{
  "role": "agent",
  "content": {
    "type": "output",
    "data": {
      "type": "message",
      "message": "I found the issue in api/session.ts"
    }
  },
  "meta": {
    "sentFrom": "cli"
  }
}
```

New session protocol format example (decrypted payload):

```json
{
  "role": "session",
  "content": {
    "id": "msg_01",
    "time": 1739347230000,
    "role": "agent",
    "turn": "turn_01",
    "ev": {
      "t": "text",
      "text": "I found the issue in api/session.ts"
    }
  },
  "meta": {
    "sentFrom": "cli"
  }
}
```

Modern session protocol user envelope (decrypted payload):

```json
{
  "role": "session",
  "content": {
    "id": "msg_legacy_user_01",
    "time": 1739347231000,
    "role": "user",
    "ev": {
      "t": "text",
      "text": "fix the failing test"
    }
  },
  "meta": {
    "sentFrom": "cli"
  }
}
```

Protocol invariant:
- outer `role = "session"` marks modern session-protocol payloads.
- inside `content`, envelope `role` is only `"user"` or `"agent"`.

Session protocol send rollout (`ENABLE_SESSION_PROTOCOL_SEND`):
- sender emits modern session-protocol user payloads (`role = "session"` with `content.role = "user"`).
- default (disabled): app consumes legacy user payloads (`role = "user"`, `content.type = "text"`) and drops modern user payloads.
- enabled: app consumes modern user payloads and drops legacy user payloads.
- truthy values: `1`, `true`, `yes` (case-insensitive).

Wire-level encrypted container (same for legacy and new):

```json
{
  "id": "msg-db-row-id",
  "seq": 101,
  "localId": null,
  "content": {
    "t": "encrypted",
    "c": "BASE64_ENCRYPTED_PAYLOAD"
  },
  "createdAt": 1739347230000,
  "updatedAt": 1739347230000
}
```

## Purpose

`@slopus/happy-wire` centralizes definitions for:
- encrypted message/update payloads
- session protocol envelope and event stream
- helper for creating valid session envelopes

The goal is to keep CLI/app/server/agent on the same wire contract and avoid schema drift.

## Package Identity

- Name: `@slopus/happy-wire`
- Workspace path: `packages/happy-wire`
- Entry: `src/index.ts`
- Runtime deps: `zod`, `@paralleldrive/cuid2`

## Public Exports

`src/index.ts` exports everything from:
- `src/messages.ts`
- `src/legacyProtocol.ts`
- `src/sessionProtocol.ts`

### `messages.ts` exports

Schemas + inferred types:
- `SessionMessageContentSchema`
- `SessionMessage`
- `SessionMessageSchema`
- `MessageMetaSchema`
- `MessageMeta`
- `SessionProtocolMessageSchema`
- `SessionProtocolMessage`
- `MessageContentSchema`
- `MessageContent`
- `VersionedEncryptedValueSchema`
- `VersionedEncryptedValue`
- `VersionedNullableEncryptedValueSchema`
- `VersionedNullableEncryptedValue`
- `UpdateNewMessageBodySchema`
- `UpdateNewMessageBody`
- `UpdateSessionBodySchema`
- `UpdateSessionBody`
- `VersionedMachineEncryptedValueSchema`
- `VersionedMachineEncryptedValue`
- `UpdateMachineBodySchema`
- `UpdateMachineBody`
- `CoreUpdateBodySchema`
- `CoreUpdateBody`
- `CoreUpdateContainerSchema`
- `CoreUpdateContainer`

Compatibility aliases:
- `ApiMessageSchema` -> `SessionMessageSchema`
- `ApiMessage` -> `SessionMessage`
- `ApiUpdateNewMessageSchema` -> `UpdateNewMessageBodySchema`
- `ApiUpdateNewMessage` -> `UpdateNewMessageBody`
- `ApiUpdateSessionStateSchema` -> `UpdateSessionBodySchema`
- `ApiUpdateSessionState` -> `UpdateSessionBody`
- `ApiUpdateMachineStateSchema` -> `UpdateMachineBodySchema`
- `ApiUpdateMachineState` -> `UpdateMachineBody`
- `UpdateBodySchema` -> `UpdateNewMessageBodySchema`
- `UpdateBody` -> `UpdateNewMessageBody`
- `UpdateSchema` -> `CoreUpdateContainerSchema`
- `Update` -> `CoreUpdateContainer`

### `legacyProtocol.ts` exports

Schemas + inferred types:
- `UserMessageSchema`
- `UserMessage`
- `AgentMessageSchema`
- `AgentMessage`
- `LegacyMessageContentSchema`
- `LegacyMessageContent`

### `sessionProtocol.ts` exports

Schemas + inferred types:
- `sessionRoleSchema`
- `SessionRole`
- `sessionTextEventSchema`
- `sessionServiceMessageEventSchema`
- `sessionToolCallStartEventSchema`
- `sessionToolCallEndEventSchema`
- `sessionFileEventSchema`
- `sessionTurnStartEventSchema`
- `sessionStartEventSchema`
- `sessionTurnEndStatusSchema`
- `SessionTurnEndStatus`
- `sessionTurnEndEventSchema`
- `sessionStopEventSchema`
- `sessionEventSchema`
- `SessionEvent`
- `sessionEnvelopeSchema`
- `SessionEnvelope`
- `CreateEnvelopeOptions`
- `createEnvelope(...)`

## Wire Type Specifications

## Common Primitive Rules

These are schema-level requirements, not just recommendations.

- `id`, `sid`, `machineId`, `call`, `name`, `title`, `description`, `ref`: `string`
- `seq`, `createdAt`, `updatedAt`, `size`, `width`, `height`, `version`, `activeAt`: `number`
- All nullable fields are explicitly marked with `.nullable()`.
- All optional fields are explicitly marked with `.optional()`.
- `.nullish()` means `undefined | null | <type>`.

## Message/Update Specs (`messages.ts`)

### `SessionMessageContentSchema`

```ts
{
  t: 'encrypted';
  c: string;
}
```

Meaning:
- `t` is a strict discriminator with value `'encrypted'`.
- `c` is encrypted payload bytes encoded as a string (typically base64 in current usage).

### `SessionMessageSchema`

```ts
{
  id: string;
  seq: number;
  localId?: string | null;
  content: SessionMessageContent;
  createdAt: number;
  updatedAt: number;
}
```

Notes:
- `localId` is `.nullish()` for compatibility with different producers.
- `createdAt` and `updatedAt` are required in this shared schema.

### `MessageMetaSchema`

```ts
{
  sentFrom?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'read-only' | 'safe-yolo' | 'yolo';
  model?: string | null;
  fallbackModel?: string | null;
  customSystemPrompt?: string | null;
  appendSystemPrompt?: string | null;
  allowedTools?: string[] | null;
  disallowedTools?: string[] | null;
  displayText?: string;
}
```

## Legacy Decrypted Payload Specs (`legacyProtocol.ts`)

### `UserMessageSchema` (legacy decrypted payload)

```ts
{
  role: 'user';
  content: {
    type: 'text';
    text: string;
  };
  localKey?: string;
  meta?: MessageMeta;
}
```

### `AgentMessageSchema` (legacy decrypted payload)

```ts
{
  role: 'agent';
  content: {
    type: string;
    [key: string]: unknown;
  };
  meta?: MessageMeta;
}
```

### `LegacyMessageContentSchema`

Discriminated union on `role`:
- `'user'` -> `UserMessageSchema`
- `'agent'` -> `AgentMessageSchema`

## Top-Level Decrypted Payload Specs (`messages.ts`)

### `SessionProtocolMessageSchema` (modern decrypted payload wrapper)

```ts
{
  role: 'session';
  content: SessionEnvelope;
  meta?: MessageMeta;
}
```

### `MessageContentSchema`

Discriminated union on top-level `role`:
- `'user'` -> `UserMessageSchema` (legacy)
- `'agent'` -> `AgentMessageSchema` (legacy)
- `'session'` -> `SessionProtocolMessageSchema` (modern)

## Message/Update Specs (`messages.ts`) Continued

### `VersionedEncryptedValueSchema`

```ts
{
  version: number;
  value: string;
}
```

Used for encrypted, version-tracked blobs that cannot be null when present.

### `VersionedNullableEncryptedValueSchema`

```ts
{
  version: number;
  value: string | null;
}
```

Used where payload presence can be intentionally reset to null while still versioning.

### `VersionedMachineEncryptedValueSchema`

```ts
{
  version: number;
  value: string;
}
```

Machine update variant. Equivalent shape to `VersionedEncryptedValueSchema`.

### `UpdateNewMessageBodySchema`

```ts
{
  t: 'new-message';
  sid: string;
  message: SessionMessage;
}
```

### `UpdateSessionBodySchema`

```ts
{
  t: 'update-session';
  id: string;
  metadata?: VersionedEncryptedValue | null;
  agentState?: VersionedNullableEncryptedValue | null;
}
```

Important distinction:
- `metadata.value` is `string` when metadata block exists.
- `agentState.value` may be `string` or `null` when block exists.

### `UpdateMachineBodySchema`

```ts
{
  t: 'update-machine';
  machineId: string;
  metadata?: VersionedMachineEncryptedValue | null;
  daemonState?: VersionedMachineEncryptedValue | null;
  active?: boolean;
  activeAt?: number;
}
```

### `CoreUpdateBodySchema`

Discriminated union on `t` with exactly 3 variants:
- `'new-message'`
- `'update-session'`
- `'update-machine'`

### `CoreUpdateContainerSchema`

```ts
{
  id: string;
  seq: number;
  body: CoreUpdateBody;
  createdAt: number;
}
```

## Session Protocol Specs (`sessionProtocol.ts`)

## Role

### `sessionRoleSchema`

```ts
'user' | 'agent'
```

Role meaning:
- `'user'`: user-originated envelope.
- `'agent'`: agent-originated envelope.

## Event Variants

`sessionEventSchema` is a discriminated union on `t` with 9 variants.

### 1) Text event

```ts
{
  t: 'text';
  text: string;
  thinking?: boolean;
}
```

### 2) Service event

```ts
{
  t: 'service';
  text: string;
}
```

### 3) Tool-call-start event

```ts
{
  t: 'tool-call-start';
  call: string;
  name: string;
  title: string;
  description: string;
  args: Record<string, unknown>;
}
```

### 4) Tool-call-end event

```ts
{
  t: 'tool-call-end';
  call: string;
}
```

### 5) File event

```ts
{
  t: 'file';
  ref: string;
  name: string;
  size: number;
  image?: {
    width: number;
    height: number;
    thumbhash: string;
  };
}
```

### 6) Turn-start event

```ts
{
  t: 'turn-start';
}
```

### 7) Start event

```ts
{
  t: 'start';
  title?: string;
}
```

### 8) Turn-end event

```ts
{
  t: 'turn-end';
  status: 'completed' | 'failed' | 'cancelled';
}
```

### 9) Stop event

```ts
{
  t: 'stop';
}
```

## Envelope

### `sessionEnvelopeSchema`

```ts
{
  id: string;
  time: number;
  role: 'user' | 'agent';
  turn?: string;
  subagent?: string; // must pass cuid2 validation when present
  ev: SessionEvent;
}
```

Additional validation (`superRefine`):
- If `ev.t === 'service'`, then `role` MUST be `'agent'`.
- If `ev.t === 'start'` or `ev.t === 'stop'`, then `role` MUST be `'agent'`.
- If `subagent` is present, it MUST satisfy `isCuid(...)`.

## Helper Function Contract

### `createEnvelope(role, ev, opts?)`

Input:
- `role: SessionRole`
- `ev: SessionEvent`
- `opts?: { id?: string; time?: number; turn?: string; subagent?: string }`

Behavior:
- If `opts.id` is absent, generates id using `createId()`.
- If `opts.time` is absent, sets `time` to `Date.now()`.
- Includes `turn` only when provided.
- Includes `subagent` only when provided.

Output:
- Returns a `SessionEnvelope` parsed by `sessionEnvelopeSchema`.
- Throws on invalid combinations (for example `role = 'user'` with `ev.t = 'service'`).

## Normative JSON Examples

## Update container with `new-message`

```json
{
  "id": "upd-1",
  "seq": 100,
  "createdAt": 1739347200000,
  "body": {
    "t": "new-message",
    "sid": "session-1",
    "message": {
      "id": "msg-1",
      "seq": 55,
      "localId": null,
      "content": {
        "t": "encrypted",
        "c": "Zm9v"
      },
      "createdAt": 1739347199000,
      "updatedAt": 1739347199000
    }
  }
}
```

### Decrypted `new-message` content example

`message.content.c` (ciphertext) decrypts into the payload below for a session-protocol message:

```json
{
  "role": "session",
  "content": {
    "id": "env_01",
    "time": 1739347232000,
    "role": "agent",
    "turn": "turn_01",
    "ev": {
      "t": "text",
      "text": "I found 3 TODOs."
    }
  },
  "meta": {
    "sentFrom": "cli"
  }
}
```

For user text migration behavior:
- clients emit only the modern payload (`role = "session"` with `content.role = "user"`).
- if `ENABLE_SESSION_PROTOCOL_SEND` is disabled, app keeps consuming legacy payloads and drops modern payloads.
- if `ENABLE_SESSION_PROTOCOL_SEND` is enabled, app consumes modern payloads and drops legacy payloads.

## Update container with `update-session`

```json
{
  "id": "upd-2",
  "seq": 101,
  "createdAt": 1739347210000,
  "body": {
    "t": "update-session",
    "id": "session-1",
    "metadata": {
      "version": 8,
      "value": "BASE64..."
    },
    "agentState": {
      "version": 13,
      "value": null
    }
  }
}
```

## Update container with `update-machine`

```json
{
  "id": "upd-3",
  "seq": 102,
  "createdAt": 1739347220000,
  "body": {
    "t": "update-machine",
    "machineId": "machine-1",
    "metadata": {
      "version": 2,
      "value": "BASE64..."
    },
    "daemonState": {
      "version": 3,
      "value": "BASE64..."
    },
    "active": true,
    "activeAt": 1739347220000
  }
}
```

## Session protocol envelope

```json
{
  "id": "x8s1k2...",
  "role": "agent",
  "turn": "turn-42",
  "ev": {
    "t": "turn-start"
  }
}
```

## Parsing/Validation Usage

```ts
import {
  CoreUpdateContainerSchema,
  sessionEnvelopeSchema,
} from '@slopus/happy-wire';

const maybeUpdate = CoreUpdateContainerSchema.safeParse(input);
if (!maybeUpdate.success) {
  // invalid update payload
}

const maybeEnvelope = sessionEnvelopeSchema.safeParse(envelopeInput);
if (!maybeEnvelope.success) {
  // invalid envelope/event payload
}
```

## Build and Distribution Specification

`package.json` contract:
- `main`: `./dist/index.cjs`
- `module`: `./dist/index.mjs`
- `types`: `./dist/index.d.cts`
- `exports["."]` provides both CJS and ESM entrypoints with type paths.

Build script:
- `shx rm -rf dist && npx tsc --noEmit && pkgroll`

Tests:
- `vitest` against `src/*.test.ts`

Publish gate:
- `prepublishOnly` runs build + test

Published files:
- `dist`
- `package.json`
- `README.md`

## Monorepo Build Dependency Behavior

In this repository, consumer workspaces import `@slopus/happy-wire` through package exports that point at `dist/*`.

That means on a clean checkout:
1. Build wire first: `yarn workspace @slopus/happy-wire build`
2. Then build/typecheck dependents.

After publishing to npm, dependents consume prebuilt artifacts from the published tarball.

## Change Policy

When modifying wire schemas:
- Prefer additive changes to keep older consumers compatible.
- Treat discriminator values (`t`) as protocol-level API and avoid breaking renames.
- Document semantic changes in this README.
- Bump package version before downstream releases that depend on new schema behavior.

## Development Commands

```bash
# from repository root
yarn workspace @slopus/happy-wire build
yarn workspace @slopus/happy-wire test
```

## Release Commands (maintainers)

```bash
# interactive release target selection from repo root
yarn release

# direct release invocation
yarn workspace @slopus/happy-wire release
```

This prepares release artifacts using the same `release-it` flow as other publishable libraries in the monorepo.
