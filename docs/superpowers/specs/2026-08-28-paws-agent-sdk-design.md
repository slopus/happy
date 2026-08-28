# Paws Agent SDK and CLI Design

**Status:** Accepted for Durable implementation

## Summary

Extract the proven remote-control capabilities in `packages/happy-agent` into a browser-safe SDK and make the `paws-agent` CLI a thin consumer of that SDK. Publish both from one package named `@wangjs-jacky/paws-agent`, with the executable name `paws-agent`.

The first release supports Paws-owned clients only. It does not introduce a third-party application platform, OAuth scopes, or a new server protocol.

## Goals

- Provide one typed SDK for listing machines, managing sessions, sending messages, receiving realtime updates, and answering agent requests.
- Keep the SDK root entry importable in Node.js and modern browsers without Node built-ins or import-time side effects.
- Preserve the existing Paws HTTP, Socket.IO, encryption, wire, and daemon RPC contracts.
- Replace the standalone control CLI branding with `paws-agent` and make every remote operation delegate to the SDK.
- Validate source, packed tarball, Node consumers, browser consumers, and an isolated end-to-end environment.
- Add auditable PR and release workflows, including exact-version post-publish verification.
- Continue Durable implementation locally while npm account recovery is pending, without weakening release verification.

## Non-goals

- Building the production Chrome extension or floating-ball UI.
- Supporting third-party applications in v1.
- Adding SSE or replacing Socket.IO.
- Rewriting Paws Server, daemon, or the shared wire protocol.
- Renaming legacy protocol fields, storage directories, or compatibility headers solely for branding.
- Calling a paid or real vendor-backed coding agent from CI.
- Publishing a placeholder npm package before the real package artifact passes release gates.

## Existing System

`packages/happy-agent` currently combines two responsibilities:

1. Reusable control logic in `api.ts`, `session.ts`, `machineRpc.ts`, and `encryption.ts`.
2. Node-specific CLI behavior in `index.ts`, `credentials.ts`, `config.ts`, `auth.ts`, and `output.ts`.

The package root executes `program.parseAsync(process.argv)`, so importing the published root has CLI side effects. Reusable modules also depend directly on Node `EventEmitter`, filesystem-based credentials, environment variables, and terminal QR output.

The existing package has substantial unit and isolated integration coverage but is not part of the repository's main PR CI or npm trusted-publishing workflow.

## Package Contract

### Identity

- npm package: `@wangjs-jacky/paws-agent`
- CLI binary: `paws-agent`
- initial development version: `0.1.0-beta.1`
- public support statement: Paws-owned clients only
- supported Node.js versions: 20 and 24
- supported browser baseline: current Chromium used by the repository's Playwright toolchain

### Public exports

```json
{
  ".": "browser-safe SDK root",
  "./node": "Node credential and configuration adapters",
  "./browser": "browser credential adapters",
  "./package.json": "package metadata"
}
```

The root export must not import `node:fs`, `node:path`, `node:os`, `node:events`, terminal libraries, Commander, or the CLI entrypoint. Importing any export must not connect a socket, read credentials, print output, or mutate global state.

The package remains dual ESM/CJS for Node consumers. Browser consumers use the ESM build.

## Public SDK API

The SDK exposes a single high-level client:

```ts
export type PawsAgentClientOptions = {
    serverUrl: string;
    credentials: CredentialProvider;
    storage?: AgentStorage;
    logger?: AgentLogger;
    reconnect?: ReconnectPolicy;
};

export class PawsAgentClient {
    constructor(options: PawsAgentClientOptions);
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    dispose(): Promise<void>;

    readonly machines: MachinesResource;
    readonly sessions: SessionsResource;
    readonly messages: MessagesResource;
    readonly requests: RequestsResource;

    subscribe(listener: PawsAgentEventListener): () => void;
}
```

Resource contracts:

```ts
export interface MachinesResource {
    list(options?: { active?: boolean }): Promise<Machine[]>;
}

export interface SessionsResource {
    list(options?: { active?: boolean }): Promise<Session[]>;
    get(sessionId: string): Promise<Session>;
    spawn(input: SpawnSessionInput): Promise<SpawnSessionResult>;
    resume(input: ResumeSessionInput): Promise<SpawnSessionResult>;
    stop(sessionId: string): Promise<void>;
}

export interface MessagesResource {
    history(sessionId: string, options?: { limit?: number }): Promise<Message[]>;
    send(input: SendMessageInput): Promise<SendMessageReceipt>;
}

export interface RequestsResource {
    approve(input: ResolveRequestInput): Promise<void>;
    reject(input: ResolveRequestInput): Promise<void>;
}
```

All public domain values are SDK-owned types. Raw Axios responses, raw Socket.IO objects, encryption keys, and server payload shapes are not public API.

## Runtime Boundaries

### Transport

- HTTP fetches snapshots, machines, sessions, and message history.
- Socket.IO receives realtime updates, sends session-scoped events, and performs machine RPC.
- The SDK owns reconnect and snapshot resynchronization.
- A reconnect is not considered complete until the SDK refreshes authoritative state and emits `ready` again.
- Message sends preserve or generate a `localId` so consumers can reconcile retries.

### Credentials

```ts
export interface CredentialProvider {
    getCredentials(): Promise<PawsCredentials | null>;
    setCredentials(credentials: PawsCredentials): Promise<void>;
    clearCredentials(): Promise<void>;
}
```

The root SDK only consumes this interface. Node and browser storage live in subpath adapters.

The Node adapter keeps compatibility with the existing Paws account credential location. Compatibility filesystem names remain internal and are not renamed as part of this project.

The browser adapter stores credentials only in the extension or application background context. Content scripts and arbitrary web pages never receive account secrets.

### Events

The root SDK uses its own typed subscription abstraction rather than Node `EventEmitter`:

```ts
export type PawsAgentEvent =
    | { type: 'connection'; state: ConnectionState }
    | { type: 'message'; sessionId: string; message: Message }
    | { type: 'session'; session: Session }
    | { type: 'request'; sessionId: string; request: AgentRequest }
    | { type: 'error'; error: PawsAgentError };
```

`subscribe()` returns an idempotent unsubscribe function. `dispose()` closes sockets, aborts requests, clears retry timers, and releases listeners.

### Errors and logging

Public errors use stable codes:

```ts
export type PawsAgentErrorCode =
    | 'AUTH_REQUIRED'
    | 'AUTH_EXPIRED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'MACHINE_OFFLINE'
    | 'SESSION_ARCHIVED'
    | 'DIRECTORY_APPROVAL_REQUIRED'
    | 'RPC_TIMEOUT'
    | 'CONNECTION_LOST'
    | 'PROTOCOL_UNSUPPORTED'
    | 'DECRYPTION_FAILED'
    | 'INVALID_ARGUMENT'
    | 'UNKNOWN';
```

Logs and thrown error messages must not include tokens, account secrets, encryption keys, decrypted message bodies, provider tokens, or complete authorization headers. The default logger is silent.

## CLI Contract

The CLI supports the existing control operations under Paws branding:

```text
paws-agent auth login|logout|status
paws-agent machines [--active] [--json]
paws-agent list [--active] [--json]
paws-agent spawn --machine <id> [--path <path>] [--agent <agent>]
paws-agent resume <session-id>
paws-agent status <session-id> [--json]
paws-agent send <session-id> <message> [--wait] [--yolo] [--json]
paws-agent history <session-id> [--limit <n>] [--json]
paws-agent approve <session-id> <request-id> [--json]
paws-agent stop <session-id>
paws-agent wait <session-id> [--timeout <seconds>]
```

The CLI owns argument parsing, terminal QR display, local credential selection, tables, JSON serialization, and exit codes. It does not call Axios, Socket.IO, or encryption helpers directly.

JSON output is machine-readable and printed only to stdout. Diagnostics go to stderr. Exit codes are stable: `0` success, `1` operational failure, and `2` invalid CLI usage.

Because the old control package was not published under the Paws scope, no public `happy-agent` binary alias is required. Internal documentation and tests migrate to `paws-agent`; legacy protocol identifiers remain untouched.

## Development and Local Delivery

While npm account recovery is pending:

- workspace consumers use `workspace:*`.
- interactive CLI testing may use pnpm's local/global link mechanism.
- release-grade checks always build `pnpm pack` tarballs and install them into clean temporary consumers.
- CI runs `npm publish --dry-run` against the tarball metadata but does not attempt registry authentication.
- no task may claim npm delivery, provenance, or registry installation has passed.

When npm access is restored, execution resumes at the registry bootstrap and publish gates without repeating already-green source and tarball checks unless relevant code or dependencies changed.

## Test Strategy

### Unit tests

- encryption vectors for legacy and data-key variants
- API request/response mapping
- domain conversion and unknown-field tolerance
- error-code normalization
- local ID generation and retry reconciliation
- event subscription and idempotent unsubscribe
- reconnect backoff and snapshot resynchronization
- disposal of sockets, timers, requests, and listeners
- Node and browser credential adapters
- CLI parsing, stdout/stderr separation, and exit codes

### Package contract tests

- build and create the exact tarball
- inspect files and exported paths
- run `publint`
- validate generated TypeScript declarations
- install in clean ESM and CJS Node consumers
- verify root import has no output, network, filesystem, or process side effects
- bundle and execute a browser consumer in Chromium
- verify the browser bundle contains no Node built-ins
- run `paws-agent --help` and `paws-agent --version` from the packed artifact
- generate and retain a SHA-256 checksum

### Isolated integration tests

Use the repository's authenticated environment, Paws Server, daemon RPC path, and deterministic fixture agent to exercise:

1. authenticate
2. list a machine
3. spawn a session in a temporary project
4. send a message
5. observe busy and idle states
6. receive the fixture response
7. resolve an approval request
8. read history
9. stop the session

Failure cases include offline machine, expired credentials, denied directory creation, RPC timeout, disconnect/reconnect, duplicate send, archived session, and another client updating the session.

No paid vendor or production user session is used by default.

## CI Design

Add `.github/workflows/paws-agent-ci.yml` triggered by changes to:

- `packages/paws-agent/**`
- `packages/happy-wire/**`
- relevant server and daemon RPC contracts
- `pnpm-lock.yaml`
- the workflow itself

Required PR jobs:

1. typecheck and unit tests on Node 20 and 24
2. packed ESM/CJS consumer tests on Linux, macOS, and Windows
3. Chromium bundle/runtime test
4. isolated protocol and daemon integration test
5. package-content, declaration, checksum, and secret-scan checks

PR jobs may cancel obsolete runs. Release jobs use a non-cancelling concurrency group and explicit timeouts. Test logs and artifacts are sanitized before upload.

## Release Design

Ordinary merges to `main` do not publish this package. A release PR owns the package version and changelog. The release PR must use the matching `release/paws-agent-v<version>` branch and `chore(agent): release paws-agent v<version>` title. Merging it creates a `paws-agent-v<version>` tag and dispatches `.github/workflows/paws-agent-npm-publish.yml`; no release tooling commits or pushes directly to `main`.

The release workflow:

1. verifies tag, package version, and commit consistency
2. installs from the frozen lockfile on a GitHub-hosted runner
3. runs all release gates
4. builds one tarball and checksum
5. publishes that exact tarball through npm Trusted Publishing
6. waits for the exact version to become visible
7. installs the exact registry version in clean Node and browser consumers
8. reruns package and isolated end-to-end smoke tests
9. creates or updates the GitHub Release with checksum and evidence

Release channels:

- prerelease versions such as `0.1.0-beta.1` use npm dist-tag `next`
- stable versions such as `0.1.0` use npm dist-tag `latest`

If publish returns an indeterminate result, the workflow queries the exact version before retrying. An existing version is never republished.

If a published stable version fails post-publish validation, automation moves `latest` back to the last healthy version, deprecates the failed version when credentials permit, fixes the defect, and publishes a new patch. npm versions are never overwritten or destructively removed.

## Durable Execution and Human Boundaries

The user has authorized uninterrupted implementation, testing, review, PR creation and updates, merge, beta publication, stable publication, GitHub Release creation, normal rollback, and release verification. These actions do not require additional confirmation after npm access is restored.

The npm account is currently in an official 2FA recovery process. Registry bootstrap, Trusted Publisher configuration, and public npm verification are deferred until recovery completes. This is the only known external blocker and does not block local implementation or tarball delivery.

Implementation does not create a custom heartbeat or recovery-state system. Durable state is represented by Git commits, the PR, CI runs, packed artifacts, and release evidence.

## Delivery Sequence

1. preserve a clean baseline and extract the browser-safe core
2. make the existing CLI use the SDK
3. rename the package, binary, documentation, and tests to Paws
4. add Node and browser adapters
5. add tarball and isolated end-to-end verification
6. add PR and release workflows
7. independently review security, package boundaries, and API stability
8. fix findings and merge through PR
9. verify the repository-mandated Web deployment and report OTA as triggered or not triggered
10. while npm recovery is pending, deliver the exact local tarball, checksum, link instructions, PR, and CI evidence
11. after recovery, complete package bootstrap, Trusted Publisher setup, beta, registry verification, stable promotion, and GitHub Release without another product decision

## Acceptance Criteria

- `PawsAgentClient` supports the documented machine, session, message, request, and event operations.
- The SDK root imports and runs in Node and Chromium without Node built-ins or side effects.
- The CLI binary is `paws-agent` and delegates remote behavior to the SDK.
- Existing encryption and server/daemon compatibility tests remain green.
- Source, tarball, ESM, CJS, Chromium, operating-system matrix, and isolated end-to-end tests pass.
- The packed artifact installs locally and its checksum is recorded.
- PR CI and tag-based release workflows are present and tested up to the unavailable registry credential boundary.
- No public-facing new code or documentation uses the old control-client brand.
- The root workspace remains clean and aligned with `origin/main`.
- Before npm recovery completes, delivery explicitly reports registry publication and OIDC verification as pending rather than passed.
- After npm recovery completes, the exact npm version installs and passes the same Node, browser, and isolated integration gates.
