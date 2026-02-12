# happy-agent CLI Tool

## Overview
A new standalone CLI tool (`happy-agent`) in `packages/happy-agent` that acts as a dedicated client for controlling Happy Coder agents remotely. Unlike `happy-cli` which both runs and controls agents, `happy-agent` only controls them — creating sessions, sending messages, reading history, monitoring state, and stopping sessions.

This is a completely separate client from `happy-cli`. It has its own authentication flow (account auth via QR code, same as device linking in the mobile app), its own credential storage (`~/.happy/agent.key`), and is written from scratch with no code sharing.

## Context
- **Existing system**: Monorepo with `happy-cli` (agent runtime + control), `happy-server` (Fastify + PostgreSQL + Redis), `happy-app` (React Native mobile)
- **Server API**: REST endpoints at `https://api.cluster-fluster.com` + Socket.IO at `/v1/updates`
- **Authentication**: Uses account auth flow (`/v1/auth/account/request` + `/v1/auth/account/response`) — generates ephemeral keypair, displays QR code (`happy:///account?[base64url-publicKey]`), user scans with existing Happy mobile app to approve, receives encrypted account secret
- **Credential storage**: `~/.happy/agent.key` (separate from happy-cli's `~/.happy/access.key`)
- **Encryption**: AES-256-GCM (dataKey) for all new sessions. The master content keypair is derived deterministically from the account secret via `deriveKey(secret, 'Happy EnCoder', ['content'])` → seed → `crypto_box_seed_keypair(seed)`. Per-session random keys are encrypted with the master public key and stored on the server.
- **Session protocol**: HTTP POST to create sessions, Socket.IO for real-time messages/state updates
- **Agent state**: `AgentState.controlledByUser` indicates if agent is actively processing; `requests` field tracks pending tool calls

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
- **CRITICAL: all tests must pass before starting next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Run tests after each change

## Testing Strategy
- **Unit tests**: Required for every task — encryption, key derivation, API client logic, CLI argument parsing, auth flow
- **Integration tests**: Test against mock server where feasible

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix

## Implementation Steps

### Task 1: Package scaffolding and build setup
- [x] Create `packages/happy-agent/` directory with `package.json` (name: `happy-agent`, type: module, bin: `./bin/happy-agent.mjs`)
- [x] Create `tsconfig.json` with strict mode, path aliases (`@/` → `src/`), ESM output
- [x] Create `bin/happy-agent.mjs` entry point wrapper (mirrors happy-cli pattern: spawns node with `--no-warnings`)
- [x] Create `src/index.ts` as main entry point with argument parsing shell
- [x] Add package to root `package.json` workspaces
- [x] Add dependencies: `axios`, `socket.io-client`, `tweetnacl`, `zod`, `chalk`, `commander`, `qrcode-terminal`
- [x] Add devDependencies: `typescript`, `vitest`, `pkgroll`, `tsx`
- [x] Create `vitest.config.ts`
- [x] Verify `yarn install` and `yarn build` work
- [x] Write smoke test that imports the package entry point
- [x] Run tests — must pass before task 2

### Task 2: Encryption and key derivation module
- [x] Create `src/encryption.ts` with `encodeBase64`, `decodeBase64`, `encodeBase64Url`, `getRandomBytes` functions
- [x] Implement `hmac_sha512(key, data)` using Node.js `createHmac('sha512', ...)`
- [x] Implement key derivation tree:
  - `deriveSecretKeyTreeRoot(seed, usage)` — HMAC-SHA512 with key = `usage + ' Master Seed'` (UTF-8), data = seed. Split 64-byte result: key = `[0:32]`, chainCode = `[32:64]`
  - `deriveSecretKeyTreeChild(chainCode, index)` — HMAC-SHA512 with key = chainCode, data = `[0x00, ...UTF-8(index)]`. Split same way.
  - `deriveKey(master, usage, path)` — derives root, then iterates path elements through child derivation
  - `deriveContentKeyPair(secret)` — calls `deriveKey(secret, 'Happy EnCoder', ['content'])` → seed → `sha512(seed)[0:32]` → `tweetnacl.box.keyPair.fromSecretKey()` → returns `{ publicKey, secretKey }`
- [x] Implement AES-256-GCM encryption:
  - `encryptWithDataKey(data, dataKey)` — AES-256-GCM: `[1-byte version=0][12-byte nonce][ciphertext][16-byte auth tag]`
  - `decryptWithDataKey(bundle, dataKey)` — reverse of above
- [x] Implement legacy encryption (needed for backward compatibility with existing sessions):
  - `encryptLegacy(data, secret)` — TweetNaCl secretbox: `[24-byte nonce][ciphertext + MAC]`
  - `decryptLegacy(data, secret)` — reverse of above
- [x] Implement `encrypt(key, variant, data)` / `decrypt(key, variant, data)` dispatcher for `'legacy' | 'dataKey'` variants
- [x] Implement `libsodiumEncryptForPublicKey(data, recipientPublicKey)` — encrypts data with NaCl box using ephemeral keypair. Bundle: `[32-byte ephemeral pubkey][24-byte nonce][ciphertext]`
- [x] Implement `decryptBoxBundle(bundle, recipientSecretKey)` — decrypts NaCl box bundle (used for auth response decryption AND per-session key decryption)
- [x] Implement `authChallenge(secret)` — generates signing keypair from secret seed, creates random 32-byte challenge, signs with `tweetnacl.sign.detached`. Returns `{ challenge, publicKey, signature }` for token refresh via `/v1/auth`
- [x] Write tests for key derivation with known test vectors:
  - seed=`'test seed'`, usage=`'test usage'`, path=`['child1','child2']`
  - Expected root key: `E6E55652456F9FE47D6FF46CA3614E85B499F77E7B340FBBB1553307CEDC1E74`
  - Expected final key: `1011C097D2105D27362B987A631496BBF68B836124D1D072E9D1613C6028CF75`
- [x] Write tests for AES-256-GCM encrypt/decrypt round-trip
- [x] Write tests for legacy encrypt/decrypt round-trip
- [x] Write tests for base64 encode/decode (standard and URL-safe)
- [x] Write tests for libsodiumEncryptForPublicKey + decryptBoxBundle round-trip
- [x] Write tests for authChallenge signature verification with `tweetnacl.sign.detached.verify`
- [x] Run tests — must pass before task 3

### Task 3: Configuration and credential storage
- [x] Create `src/config.ts` — reads `HAPPY_SERVER_URL` (default: `https://api.cluster-fluster.com`), `HAPPY_HOME_DIR` (default: `~/.happy`), derives credential file path as `${happyHomeDir}/agent.key`
- [x] Create `src/credentials.ts`:
  - `Credentials` type: `{ token: string, secret: Uint8Array, contentKeyPair: { publicKey: Uint8Array, secretKey: Uint8Array } }`
  - `readCredentials(config)` — parses `~/.happy/agent.key` JSON `{ token, secret }`, decodes secret from base64, derives contentKeyPair via `deriveContentKeyPair(secret)`. Returns `Credentials` or `null` if file missing.
  - `writeCredentials(config, token, secret)` — writes `{ token, secret: base64(secret) }` to `~/.happy/agent.key`
  - `clearCredentials(config)` — deletes `~/.happy/agent.key`
  - `requireCredentials(config)` — calls `readCredentials`, throws with "Run `happy-agent auth login` first" if null
- [x] Write tests for credential read/write round-trip (use temp directory)
- [x] Write tests for contentKeyPair derivation from secret
- [x] Write tests for missing file returns null
- [x] Write tests for config defaults and env var overrides
- [x] Run tests — must pass before task 4

### Task 4: Authentication command (`happy-agent auth`)
- [x] Create `src/auth.ts` implementing the account auth flow:
  1. Generate ephemeral box keypair: `tweetnacl.box.keyPair.fromSecretKey(randomBytes(32))`
  2. POST `/v1/auth/account/request` with `{ publicKey: base64(keypair.publicKey) }`
  3. Generate QR code data: `happy:///account?` + base64url(keypair.publicKey)
  4. Display QR code in terminal using `qrcode-terminal`
  5. Print instructions: "Scan this QR code with the Happy app (Settings → Account → Link New Device)"
  6. Poll `/v1/auth/account/request` every 1 second with same publicKey
  7. When `state === 'authorized'`: decrypt `response` using `decryptBoxBundle(decodeBase64(response), keypair.secretKey)` to get the account secret (32 bytes)
  8. Save token + secret via `writeCredentials(config, token, secret)`
  9. Print success message
- [x] Add `happy-agent auth login` subcommand that runs the flow above
- [x] Add `happy-agent auth logout` subcommand that calls `clearCredentials()`
- [x] Add `happy-agent auth status` subcommand that reads credentials and prints auth status (authenticated / not authenticated)
- [x] Write tests for auth flow with mocked HTTP (polling, success case)
- [x] Write tests for auth flow error cases (server unreachable, timeout)
- [x] Write tests for logout (credential deletion)
- [x] Run tests — must pass before task 5

### Task 5: HTTP API client
- [x] Create `src/api.ts` with functions:
  - `listSessions(config, creds)` — GET `/v1/sessions`, for each session: resolve encryption key (see key resolution below), decrypt metadata/agentState, return decrypted session list
  - `listActiveSessions(config, creds)` — GET `/v2/sessions/active`, same decryption logic
  - `createSession(config, creds, opts: { tag, metadata })` — POST `/v1/sessions`:
    - Generate random 32-byte per-session AES key
    - Encrypt it with `libsodiumEncryptForPublicKey(sessionKey, creds.contentKeyPair.publicKey)` → prepend version byte `[0x00]` → base64 for `dataEncryptionKey` field
    - Encrypt metadata with `encryptWithDataKey(metadata, sessionKey)`
    - Returns decrypted session with the sessionKey attached
  - `getSessionMessages(config, creds, sessionId)` — GET `/v1/sessions/:id/messages`
  - `deleteSession(config, creds, sessionId)` — DELETE `/v1/sessions/:id`
- [x] Implement session encryption key resolution for existing sessions:
  - If session has `dataEncryptionKey`: strip version byte, `decryptBoxBundle(encrypted, creds.contentKeyPair.secretKey)` → per-session AES key, use `'dataKey'` variant
  - If session has no `dataEncryptionKey`: use `creds.secret` as key with `'legacy'` variant
- [x] All requests include `Authorization: Bearer <token>` header
- [x] All functions handle HTTP errors gracefully (404 → "not found", 401 → "re-authenticate", 5xx → "server error")
- [x] Write tests with mocked axios for listSessions (success + error)
- [x] Write tests for session key resolution (dataKey and legacy paths)
- [x] Write tests with mocked axios for createSession (new + existing tag)
- [x] Write tests with mocked axios for getSessionMessages
- [x] Write tests with mocked axios for deleteSession
- [x] Run tests — must pass before task 6

### Task 6: Socket.IO session client
- [x] Create `src/session.ts` — `SessionClient` class that:
  - Takes session ID, encryption key, encryption variant, token, server URL
  - Connects to Socket.IO at `serverUrl/v1/updates` with `{ token, clientType: 'session-scoped', sessionId }`
  - Listens for `update` events, decrypts messages using session encryption key (AES-256-GCM or legacy depending on variant), emits typed events (`message`, `state-change`)
  - Provides `sendMessage(text, meta?)` — encrypts user message with session key and emits `message` event with `{ sid, message }`
  - Provides `getMetadata()` / `getAgentState()` — returns current cached decrypted state
  - Provides `waitForIdle(timeoutMs?)` — watches `agentState.controlledByUser` and `agentState.requests`, resolves when agent has no pending requests and `controlledByUser !== true`
  - Provides `sendStop()` — emits `session-end` event
  - Provides `close()` — disconnects socket
- [x] Write tests for SessionClient message encryption/sending (mock socket.io-client)
- [x] Write tests for waitForIdle logic (various agentState combinations)
- [x] Write tests for update event handling and decryption
- [x] Run tests — must pass before task 7

### Task 7: CLI commands — `list` and `status`
- [x] Create `src/index.ts` using `commander` with program name `happy-agent`
- [x] `happy-agent list` — calls `listSessions`, displays table: ID (truncated), name/summary, path, status (active/inactive), last active time. With `--json` outputs raw JSON. With `--active` filters to active only.
- [x] `happy-agent status <session-id>` — fetches session via list + filter by ID prefix, connects Socket.IO to get live state, displays: session ID, metadata (path, host, lifecycle state), agent state (idle/busy, pending requests count), last message preview. With `--json` outputs raw JSON. Disconnects after displaying.
- [x] Create `src/output.ts` — helper for human-readable vs JSON formatting based on `--json` flag
- [x] Write tests for output formatting (human-readable table, JSON mode)
- [x] Write tests for CLI argument parsing (list, list --active, list --json, status <id>)
- [x] Run tests — must pass before task 8

### Task 8: CLI commands — `create` and `send`
- [x] `happy-agent create --tag <tag> [--path <path>]` — creates new session with given tag and metadata (path defaults to cwd, host to hostname). Prints session ID. With `--json` outputs full session JSON.
- [x] `happy-agent send <session-id> <message>` — resolves session key, connects Socket.IO, sends user message (encrypted with AES-256-GCM), optionally waits for idle with `--wait`. Disconnects after. Prints confirmation. With `--json` outputs message details.
- [x] Write tests for create command (argument parsing, metadata construction)
- [x] Write tests for send command (message encryption, --wait flag)
- [x] Run tests — must pass before task 9

### Task 9: CLI commands — `history`, `stop`, and `wait`
- [x] `happy-agent history <session-id>` — fetches messages via HTTP, resolves session encryption key (dataKey or legacy), decrypts each message, displays in chronological order with role/timestamp. With `--json` outputs raw JSON. With `--limit <n>` limits output.
- [x] `happy-agent stop <session-id>` — connects Socket.IO, sends `session-end` event, disconnects. Prints confirmation.
- [x] `happy-agent wait <session-id> [--timeout <seconds>]` — connects Socket.IO, waits for agent idle state (no pending requests, not controlled by user), prints when idle or times out (default 300s). Exit code 0 on idle, 1 on timeout.
- [x] Write tests for history command (message decryption, chronological ordering, --limit)
- [x] Write tests for stop command
- [x] Write tests for wait command (idle detection, timeout handling)
- [x] Run tests — must pass before task 10

### Task 10: Verify acceptance criteria
- [x] Verify all 8 operations work: auth, create, send, stop, history, wait, status, list
- [x] Verify `--json` flag works on all applicable commands
- [x] Verify error handling: no credentials, server unreachable, invalid session ID
- [x] Verify interop: session created by happy-agent is visible and controllable from mobile app
- [x] Verify interop: session created by happy-cli can be listed and history read by happy-agent
- [x] Run full test suite (unit tests)
- [x] Run linter — all issues must be fixed

### Task 11: [Final] Update documentation
- [x] Add README.md to `packages/happy-agent/` with usage examples for all commands
- [x] Update root README if it references packages

## Technical Details

### CLI Commands Summary
```
happy-agent auth login                          # Authenticate via QR code (scanned by Happy mobile app)
happy-agent auth logout                         # Clear stored credentials
happy-agent auth status                         # Show authentication status

happy-agent list [--active] [--json]            # List all sessions
happy-agent status <session-id> [--json]        # Get live session state
happy-agent create --tag <tag> [--path <path>] [--json]  # Create new session
happy-agent send <session-id> <message> [--wait] [--json]  # Send message
happy-agent history <session-id> [--limit <n>] [--json]    # Read message history
happy-agent stop <session-id>                   # Stop a session
happy-agent wait <session-id> [--timeout <s>]   # Wait for agent to become idle
```

### Authentication Flow (Account Auth)
```
happy-agent                          Happy Server                    Happy Mobile App
     |                                    |                               |
     +-- Generate ephemeral keypair       |                               |
     +-- POST /v1/auth/account/request -> |                               |
     |   { publicKey }                    |                               |
     |                                    |                               |
     +-- Display QR code in terminal      |                               |
     |   happy:///account?[base64url-key] |                               |
     |                                    |                               |
     |                                    |  <-- User scans QR code ------+
     |                                    |                               |
     |                                    |  <-- POST /v1/auth/account/response
     |                                    |      { publicKey,             |
     |                                    |        response: box.encrypt( |
     |                                    |          accountSecret,       |
     |                                    |          ephemeralPubKey) }   |
     |                                    |                               |
     +-- Poll /v1/auth/account/request -> |                               |
     |   state: 'authorized'              |                               |
     |   token: JWT                       |                               |
     |   response: encrypted secret       |                               |
     |                                    |                               |
     +-- box.open(response, ephemeralSK)  |                               |
     |   -> accountSecret (32 bytes)      |                               |
     +-- Save { token, secret }           |                               |
     |   to ~/.happy/agent.key            |                               |
     |                                    |                               |
     +-- Derive content keypair:          |                               |
     |   deriveKey(secret,                |                               |
     |     'Happy EnCoder', ['content'])  |                               |
     |   -> seed -> box keypair           |                               |
     |   (publicKey for encrypting        |                               |
     |    per-session keys,               |                               |
     |    secretKey for decrypting them)  |                               |
     v Authenticated                      |                               |
```

### Credential File Format (`~/.happy/agent.key`)
```json
{
  "token": "jwt-auth-token",
  "secret": "base64-encoded-32-byte-account-secret"
}
```

At load time, the content keypair is derived from the secret:
```
secret (32 bytes)
  -> deriveKey(secret, 'Happy EnCoder', ['content'])
  -> seed (32 bytes)
  -> sha512(seed)[0:32] -> boxSecretKey
  -> tweetnacl.box.keyPair.fromSecretKey(boxSecretKey)
  -> { publicKey (32 bytes), secretKey (32 bytes) }
```

### Key Derivation Tree
```
HMAC-SHA512 based key tree (matches mobile app implementation):

deriveSecretKeyTreeRoot(seed, usage):
  I = HMAC-SHA512(key = UTF8(usage + ' Master Seed'), data = seed)
  key = I[0:32], chainCode = I[32:64]

deriveSecretKeyTreeChild(chainCode, index):
  data = [0x00, ...UTF8(index)]
  I = HMAC-SHA512(key = chainCode, data = data)
  key = I[0:32], chainCode = I[32:64]

deriveKey(master, usage, path):
  state = deriveSecretKeyTreeRoot(master, usage)
  for each element in path:
    state = deriveSecretKeyTreeChild(state.chainCode, element)
  return state.key

Test vectors:
  seed = UTF8('test seed'), usage = 'test usage', path = ['child1', 'child2']
  Root key:  E6E55652456F9FE47D6FF46CA3614E85B499F77E7B340FBBB1553307CEDC1E74
  Final key: 1011C097D2105D27362B987A631496BBF68B836124D1D072E9D1613C6028CF75
```

### Encryption

**For new sessions (created by happy-agent):**
1. Generate random 32-byte per-session key
2. Encrypt per-session key with master publicKey via `libsodiumEncryptForPublicKey` → store as `dataEncryptionKey` on server
3. Encrypt/decrypt all session data (metadata, messages, agentState) with AES-256-GCM using the per-session key

**For existing sessions (created by happy-cli or other clients):**
1. If session has `dataEncryptionKey`: strip version byte `[0]`, `decryptBoxBundle(encrypted, contentKeyPair.secretKey)` → per-session AES key, use AES-256-GCM
2. If session has no `dataEncryptionKey`: use `secret` directly as key with legacy TweetNaCl secretbox

**AES-256-GCM bundle format:** `[1-byte version=0][12-byte nonce][ciphertext][16-byte auth tag]`
**Legacy secretbox bundle format:** `[24-byte nonce][ciphertext + MAC]`
**Box encryption bundle format:** `[32-byte ephemeral pubkey][24-byte nonce][ciphertext]`

### Idle Detection Logic
Agent is considered idle when ALL of these are true:
1. `agentState.controlledByUser` is not `true`
2. `agentState.requests` is empty or undefined (no pending tool calls)
3. Session metadata `lifecycleState` is not `'archived'`

### Dependencies (minimal)
- `axios` — HTTP client
- `socket.io-client` — WebSocket communication
- `tweetnacl` — Encryption (box for key exchange, secretbox for legacy, sign for auth challenge)
- `zod` — Runtime validation
- `chalk` — Terminal colors
- `commander` — CLI argument parsing
- `qrcode-terminal` — QR code display for authentication

## Post-Completion
**Manual verification:**
- Test full auth flow: run `happy-agent auth login`, scan QR with Happy app, verify credentials saved
- Test with real server: create session, send message, verify it appears in mobile app
- Test `wait` command with a running agent session
- Test `history` command for sessions created by both `happy-agent` and `happy-cli`
- Test cross-client interop: messages from happy-agent readable by mobile app and vice versa

**Distribution:**
- Package can be published to npm as `happy-agent`
- Alternatively, users install from monorepo via `yarn workspace happy-agent build`
