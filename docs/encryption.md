# Encryption and Data Encoding

This document details how client data is encrypted, how encrypted blobs are structured, and how those blobs map onto protocol fields. It is based on `packages/happy-cli/src/api/encryption.ts` and the server routes that accept/emit these values.

For transport and event shapes, see `protocol.md`. For HTTP endpoints, see `api.md`.

## Overview

```mermaid
graph TB
    subgraph "Client (CLI/Mobile)"
        Plain[Plaintext Data]
        ClientEnc[Client Encryption]
        B64[Base64 Encoded]
    end

    subgraph "Transport"
        Wire[HTTP / WebSocket]
    end

    subgraph "Server"
        Store[(Postgres)]
        ServerEnc[Server Encryption]
        Tokens[Service Tokens]
    end

    Plain --> ClientEnc --> B64 --> Wire --> Store
    Tokens --> ServerEnc --> Store

    style Plain fill:#e8f5e9
    style B64 fill:#fff3e0
    style Store fill:#e3f2fd
```

## Design goals
- Keep the server blind to user content (end-to-end encryption on clients).
- Use explicit, stable binary layouts so clients can interoperate across versions.
- Prefer simple, consistent base64 encoding on the wire.

## Encryption variants

```mermaid
graph LR
    subgraph "Variant Selection"
        Check{Has dataKey?}
        Check --> |No| Legacy[Legacy NaCl]
        Check --> |Yes| DataKey[DataKey AES-GCM]
    end

    subgraph "Legacy"
        L1[XSalsa20-Poly1305]
        L2[32-byte shared secret]
    end

    subgraph "DataKey"
        D1[AES-256-GCM]
        D2[Per-session/machine key]
    end

    Legacy --> L1 & L2
    DataKey --> D1 & D2
```

Clients currently use one of two encryption variants:

### 1) legacy (NaCl secretbox)
Used when the client only has a shared secret key.

**Algorithm**: `tweetnacl.secretbox` (XSalsa20-Poly1305)
- **Nonce length**: 24 bytes
- **Key length**: 32 bytes

**Binary layout** (plaintext JSON -> bytes):
```
[ nonce (24) | ciphertext+auth (secretbox output) ]
```

```mermaid
packet-beta
  0-23: "nonce (24 bytes)"
  24-55: "ciphertext + auth tag"
```

### 2) dataKey (AES-256-GCM)
Used when the client supports per-session/per-machine data keys.

**Algorithm**: AES-256-GCM
- **Nonce length**: 12 bytes
- **Auth tag**: 16 bytes
- **Key length**: 32 bytes

**Binary layout**:
```
[ version (1) | nonce (12) | ciphertext (...) | authTag (16) ]
```

```mermaid
packet-beta
  0-0: "ver"
  1-12: "nonce (12 bytes)"
  13-44: "ciphertext (...)"
  45-60: "authTag (16 bytes)"
```

- `version` is currently `0`.

## Data encryption key (dataKey variant)
When `dataKey` is used, the actual content key is encrypted for storage/transport.

**Algorithm**: `tweetnacl.box` with an ephemeral keypair.
- **Ephemeral public key**: 32 bytes
- **Nonce**: 24 bytes

**Binary layout**:
```
[ ephPublicKey (32) | nonce (24) | ciphertext (...) ]
```

This blob is then wrapped with a version byte before being sent/stored:
```
[ version (1 = 0) | boxBundle (...) ]
```

The resulting bytes are base64-encoded and placed in fields such as `dataEncryptionKey` for sessions/machines/artifacts.

## Where encryption is applied
The server treats these fields as opaque strings/blobs. The client encrypts them before sending.

### Session metadata + agent state
- **Encrypted by client** and stored as strings in the DB.
- Used in:
  - `POST /v1/sessions` (create/load)
  - WebSocket `update-metadata` / `update-state`
  - `update-session` events

### Session messages
- Client emits `message` with a base64 encrypted blob.
- Server stores it as `SessionMessage.content`:
  - `{ t: "encrypted", c: "<base64>" }`
- Server emits it back in `new-message` updates with the same structure.

### Machine metadata + daemon state
- **Encrypted by client** and stored as strings in the DB.
- Used in:
  - `POST /v1/machines`
  - WebSocket `machine-update-metadata` / `machine-update-state`
  - `update-machine` events

### Artifacts
- `header` and `body` are encrypted bytes encoded as base64 on the wire.
- Stored as `Bytes` in the DB.
- Emitted in `new-artifact` / `update-artifact` events as base64 strings.

### Access keys
- `AccessKey.data` is treated as an **opaque encrypted string**.
- The server does not decode it or inspect its contents.

### Key-value store
- `UserKVStore.value` is encrypted bytes encoded as base64 on the wire.
- `kvMutate` expects base64 strings; `kvGet/list/bulk` return base64 strings.

## On-wire formats (encrypted fields)
Below are the typical JSON shapes that carry encrypted data. All `...` values are base64 strings representing encrypted bytes.

### Session creation
```
POST /v1/sessions
{
  "tag": "<string>",
  "metadata": "<base64 encrypted>",
  "agentState": "<base64 encrypted or null>",
  "dataEncryptionKey": "<base64 data key bundle or null>"
}
```

### Encrypted message (client -> server)
```
Socket emit: "message"
{
  "sid": "<session id>",
  "message": "<base64 encrypted>"
}
```

### Encrypted message (server -> client)
```
update.body.t = "new-message"
update.body.message.content = {
  "t": "encrypted",
  "c": "<base64 encrypted>"
}
```

### Session metadata update (WebSocket)
```
Socket emit: "update-metadata"
{
  "sid": "<session id>",
  "metadata": "<base64 encrypted>",
  "expectedVersion": 3
}
```

### Machine update (WebSocket)
```
Socket emit: "machine-update-state"
{
  "machineId": "<machine id>",
  "daemonState": "<base64 encrypted>",
  "expectedVersion": 2
}
```

### Artifact create/update (HTTP)
```
POST /v1/artifacts
{
  "id": "<uuid>",
  "header": "<base64 encrypted>",
  "body": "<base64 encrypted>",
  "dataEncryptionKey": "<base64 data key bundle>"
}
```

### KV mutate (HTTP)
```
POST /v1/kv
{
  "mutations": [
    { "key": "prefs.theme", "value": "<base64 encrypted>", "version": 2 },
    { "key": "prefs.legacy", "value": null, "version": 5 }
  ]
}
```

## Client-side types (shapes used before encryption)
These are the client-side structures that get encrypted and sent over the wire. They are defined in `packages/happy-cli/src/api/types.ts`.\n\n### Session message content (encrypted)\nThe payload stored in `SessionMessage.content` is always encrypted and wrapped as:\n```\n{ \"t\": \"encrypted\", \"c\": \"<base64 encrypted>\" }\n```\n\n### Encrypted message payload (plaintext before encryption)\nMessages are encrypted as `MessageContent` and then base64 encoded:\n\n**User message**\n```\n{\n  \"role\": \"user\",\n  \"content\": { \"type\": \"text\", \"text\": \"...\" },\n  \"localKey\"?: \"...\",\n  \"meta\"?: { ... }\n}\n```\n\n**Agent message**\n```\n{\n  \"role\": \"agent\",\n  \"content\": { \"type\": \"output\" | \"codex\" | \"acp\" | \"event\", \"data\": ... },\n  \"meta\"?: { ... }\n}\n```\n\n### Metadata (encrypted)\n```\n{\n  \"path\": \"...\",\n  \"host\": \"...\",\n  \"homeDir\": \"...\",\n  \"happyHomeDir\": \"...\",\n  \"happyLibDir\": \"...\",\n  \"happyToolsDir\": \"...\",\n  \"version\"?: \"...\",\n  \"name\"?: \"...\",\n  \"os\"?: \"...\",\n  \"summary\"?: { \"text\": \"...\", \"updatedAt\": 123 },\n  \"machineId\"?: \"...\",\n  \"claudeSessionId\"?: \"...\",\n  \"tools\"?: [\"...\"],\n  \"slashCommands\"?: [\"...\"],\n  \"startedFromDaemon\"?: true,\n  \"hostPid\"?: 12345,\n  \"startedBy\"?: \"daemon\" | \"terminal\",\n  \"lifecycleState\"?: \"running\" | \"archiveRequested\" | \"archived\" | string,\n  \"lifecycleStateSince\"?: 123,\n  \"archivedBy\"?: \"...\",\n  \"archiveReason\"?: \"...\",\n  \"flavor\"?: \"...\"\n}\n```\n\n### Agent state (encrypted)\n```\n{\n  \"controlledByUser\"?: true | false | null,\n  \"requests\"?: {\n    \"<id>\": { \"tool\": \"...\", \"arguments\": ..., \"createdAt\": 123 }\n  },\n  \"completedRequests\"?: {\n    \"<id>\": {\n      \"tool\": \"...\",\n      \"arguments\": ...,\n      \"createdAt\": 123,\n      \"completedAt\": 123,\n      \"status\": \"canceled\" | \"denied\" | \"approved\",\n      \"reason\"?: \"...\",\n      \"mode\"?: \"default\" | \"acceptEdits\" | \"bypassPermissions\" | \"plan\" | \"read-only\" | \"safe-yolo\" | \"yolo\",\n      \"decision\"?: \"approved\" | \"approved_for_session\" | \"denied\" | \"abort\",\n      \"allowTools\"?: [\"...\"]\n    }\n  }\n}\n```\n\n### Machine metadata (encrypted)\n```\n{\n  \"host\": \"...\",\n  \"platform\": \"...\",\n  \"happyCliVersion\": \"...\",\n  \"homeDir\": \"...\",\n  \"happyHomeDir\": \"...\",\n  \"happyLibDir\": \"...\"\n}\n```\n\n### Daemon state (encrypted)\n```\n{\n  \"status\": \"running\" | \"shutting-down\" | string,\n  \"pid\"?: 123,\n  \"httpPort\"?: 123,\n  \"startedAt\"?: 123,\n  \"shutdownRequestedAt\"?: 123,\n  \"shutdownSource\"?: \"mobile-app\" | \"cli\" | \"os-signal\" | \"unknown\" | string\n}\n```\n+
## Decryption flow (client side)
- Read base64 field from API/Socket.
- Decode base64 to bytes.
- Choose encryption variant (`legacy` or `dataKey`) based on local credentials.
- Decrypt bytes using the appropriate key and algorithm.

For `dataKey`, clients must first decrypt or derive the per-session/per-machine data key from the stored `dataEncryptionKey` bundle.

## Server-side encryption (service tokens)
The server encrypts certain third-party tokens at rest:
- GitHub OAuth tokens (`GithubUser.token`).
- Vendor service tokens (`ServiceAccountToken.token`).

These are encrypted with a server-only KeyTree derived from `HANDY_MASTER_SECRET` and are not end-to-end encrypted.

## Encoding conventions
- All encrypted bytes are base64 strings on the wire unless explicitly noted.
- Timestamps remain plain numbers (epoch ms) and are not encrypted by the server.
- Non-encrypted identifiers (ids, tags, versions) are always plain strings/numbers.

## Implementation references
- Client crypto: `packages/happy-cli/src/api/encryption.ts`
- Session message format: `packages/happy-cli/src/api/types.ts`
- Server message ingestion: `packages/happy-server/sources/app/api/socket/sessionUpdateHandler.ts`
- Artifact/KV routes: `packages/happy-server/sources/app/api/routes/artifactsRoutes.ts`, `packages/happy-server/sources/app/kv/kvMutate.ts`
