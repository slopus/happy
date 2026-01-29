# Encryption and Data Encoding

This document describes how data is protected in transit and at rest, and which parts of the protocol are opaque to the server. For event shapes and transport details, see `protocol.md`. For HTTP endpoints, see `api.md`.

## Design goals
- The server should not need plaintext for user content.
- Clients own encryption keys and encrypt before sending.
- The protocol should make encrypted payloads explicit and stable.

## What the server can and cannot read
### Client-encrypted content (server opaque)
These fields are encrypted on the client and stored as opaque strings or bytes. The server treats them as blobs:
- Session metadata and agent state (`Session.metadata`, `Session.agentState`).
- Session message payloads (`SessionMessage.content` contains `{ t: "encrypted", c: <ciphertext> }`).
- Machine metadata and daemon state (`Machine.metadata`, `Machine.daemonState`).
- Artifact header/body (`Artifact.header`, `Artifact.body`).
- Access key data (`AccessKey.data`).
- KV store values (`UserKVStore.value`).

### Server-encrypted content
The server encrypts certain service tokens before storage using a KeyTree derived from `HANDY_MASTER_SECRET`:
- GitHub OAuth access tokens (`GithubUser.token`).
- Vendor service tokens (`ServiceAccountToken.token`) for `openai`, `anthropic`, `gemini`.

These tokens are encrypted by the server for at-rest protection; they are not end-to-end encrypted with client keys.

## On-wire encoding
The protocol consistently uses base64 for binary data:
- `dataEncryptionKey` fields (sessions, machines, artifacts) are base64 strings on the wire.
- Artifact `header` and `body` are base64 strings on the wire.
- KV values are base64 strings on the wire.

Strings such as session metadata, agent state, and daemon state are already encrypted client-side and sent as opaque strings.

## Authentication crypto
- Auth uses public key signatures for the initial challenge response (`/v1/auth`).
- Bearer tokens are minted and verified server-side via privacy-kit using `HANDY_MASTER_SECRET`.
- The same Bearer token is used for HTTP requests and the Socket.IO handshake.

## Storage-level notes
- Prisma stores encrypted blobs as `Bytes` for artifacts, KV values, GitHub tokens, and vendor tokens.
- S3/MinIO is used for user-uploaded assets (e.g., avatars). Those are not end-to-end encrypted.

## Key implementation references
- Server encryption helpers: `packages/happy-server/sources/modules/encrypt.ts`
- Auth tokens: `packages/happy-server/sources/app/auth/auth.ts`
- Prisma schema: `packages/happy-server/prisma/schema.prisma`
- Artifact + KV handling: `packages/happy-server/sources/app/api/routes/artifactsRoutes.ts`, `packages/happy-server/sources/app/kv/kvMutate.ts`
