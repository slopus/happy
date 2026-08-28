# Paws Agent SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a browser-safe `PawsAgentClient` SDK and a thin `paws-agent` CLI from the single package `@wangjs-jacky/paws-agent`, with packed-artifact, browser, isolated integration, CI, and deferred npm release verification.

**Architecture:** Move the old control client to `packages/paws-agent`, separate browser-safe SDK modules from Node-only CLI adapters, and expose the SDK at the package root. Preserve the existing HTTP, Socket.IO, encryption, and daemon RPC contracts while replacing Node-only crypto and event dependencies in the root graph with browser-safe audited primitives and typed subscriptions.

**Tech Stack:** TypeScript 5.9, Socket.IO client 4.8, Axios 1.13, TweetNaCl, Noble Ciphers/Hashes, StableLib Base64, Web Crypto random values, Zod/shared wire schemas, Commander 13, Vitest 3, Playwright/Chromium, pkgroll, pnpm 10, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-28-paws-agent-sdk-design.md`

## Global Constraints

- The npm package is `@wangjs-jacky/paws-agent`; the only public control binary is `paws-agent`.
- The first public support contract is Paws-owned clients only.
- The package root is browser-safe and has no import-time I/O or CLI side effects.
- Supported Node.js versions are 20 and 24; browser verification uses repository Chromium.
- HTTP and Socket.IO remain the transports; do not introduce SSE.
- Existing server, wire, daemon RPC, encryption payloads, and compatible credential storage remain interoperable.
- Public logs and errors never expose tokens, account secrets, encryption keys, provider tokens, or decrypted message bodies.
- Use a deterministic fixture agent for automated end-to-end tests; do not call a paid vendor agent.
- Development may use workspace or local link, but release claims must come from the exact packed tarball.
- npm bootstrap, OIDC, beta, stable, and registry-install checks remain pending until account recovery completes.
- Work only in `/Users/jacky/jacky-github/happy--paws-agent-sdk`; keep the root checkout clean on `main`.

---

## File Map

### Public SDK

- `packages/paws-agent/src/index.ts` — browser-safe public exports only.
- `packages/paws-agent/src/client/PawsAgentClient.ts` — client lifecycle and resource composition.
- `packages/paws-agent/src/client/events.ts` — typed subscriptions without Node EventEmitter.
- `packages/paws-agent/src/client/errors.ts` — stable error codes and sanitization.
- `packages/paws-agent/src/client/types.ts` — public domain and option types.
- `packages/paws-agent/src/transport/http.ts` — authenticated HTTP and error normalization.
- `packages/paws-agent/src/transport/realtime.ts` — Socket.IO lifecycle, updates, and RPC.
- `packages/paws-agent/src/crypto/encryption.ts` — synchronous browser-safe encoding, Noble AES/HMAC/SHA, and TweetNaCl compatibility implementation.
- `packages/paws-agent/src/crypto/records.ts` — record-key resolution and encrypted field mapping.
- `packages/paws-agent/src/resources/machines.ts` — machine queries.
- `packages/paws-agent/src/resources/sessions.ts` — session list/get/spawn/resume/stop.
- `packages/paws-agent/src/resources/messages.ts` — history and idempotent send.
- `packages/paws-agent/src/resources/requests.ts` — approval and rejection events.

### Platform adapters and CLI

- `packages/paws-agent/src/node.ts` — Node adapter exports.
- `packages/paws-agent/src/browser.ts` — browser adapter exports.
- `packages/paws-agent/src/adapters/nodeCredentials.ts` — compatible filesystem credential store.
- `packages/paws-agent/src/adapters/browserCredentials.ts` — injected browser storage adapter.
- `packages/paws-agent/src/cli.ts` — Commander program construction and execution.
- `packages/paws-agent/src/cli/output.ts` — text and JSON formatting.
- `packages/paws-agent/bin/paws-agent.mjs` — executable wrapper.

### Verification and delivery

- `packages/paws-agent/src/**/*.test.ts` — unit and CLI tests.
- `packages/paws-agent/test/consumer/**` — packed ESM/CJS and import-safety consumers.
- `packages/paws-agent/test/browser/**` — Chromium bundle/runtime harness.
- `packages/paws-agent/src/paws-agent.integration.test.ts` — isolated full-stack tests.
- `packages/paws-agent/scripts/verify-pack.mjs` — pack, inspect, install, checksum, and smoke checks.
- `.github/workflows/paws-agent-ci.yml` — PR/source/package/integration gates.
- `.github/workflows/paws-agent-npm-publish.yml` — tag-gated exact-tarball publish and post-publish gates.

---

### Task 1: Rename the workspace and separate package entries

**Files:**
- Rename: `packages/happy-agent` → `packages/paws-agent`
- Modify: `packages/paws-agent/package.json`
- Rename: `packages/paws-agent/bin/happy-agent.mjs` → `packages/paws-agent/bin/paws-agent.mjs`
- Rename: `packages/paws-agent/src/index.ts` → `packages/paws-agent/src/cli.ts`
- Create: `packages/paws-agent/src/index.ts`
- Create: `packages/paws-agent/src/node.ts`
- Create: `packages/paws-agent/src/browser.ts`
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json`
- Modify: `Dockerfile`
- Modify: `pnpm-lock.yaml`
- Test: `packages/paws-agent/src/package-entry.test.ts`

**Interfaces:**
- Produces: package root `@wangjs-jacky/paws-agent`, subpaths `./node` and `./browser`, binary `paws-agent`.
- Preserves: all old implementation modules internally until later tasks replace their imports.

- [ ] **Step 1: Write an import-safety test that fails against the old entrypoint**

```ts
import { describe, expect, it, vi } from 'vitest';

describe('package root', () => {
    it('imports without parsing argv or printing output', async () => {
        const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await import('./index');
        expect(stdout).not.toHaveBeenCalled();
        expect(stderr).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run the focused test and confirm it exposes the CLI-root coupling**

Run: `pnpm --filter happy-agent exec vitest run src/package-entry.test.ts`

Expected: failure or Commander side effect because the old root runs `parseAsync(process.argv)`.

- [ ] **Step 3: Rename the workspace and declare independent build entries**

Set the package identity and entries:

```json
{
  "name": "@wangjs-jacky/paws-agent",
  "version": "0.1.0-beta.1",
  "type": "module",
  "bin": { "paws-agent": "./bin/paws-agent.mjs" },
  "main": "./dist/index.cjs",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.cts",
  "exports": {
    ".": {
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" },
      "import": { "types": "./dist/index.d.mts", "default": "./dist/index.mjs" }
    },
    "./node": {
      "require": { "types": "./dist/node.d.cts", "default": "./dist/node.cjs" },
      "import": { "types": "./dist/node.d.mts", "default": "./dist/node.mjs" }
    },
    "./browser": {
      "require": { "types": "./dist/browser.d.cts", "default": "./dist/browser.cjs" },
      "import": { "types": "./dist/browser.d.mts", "default": "./dist/browser.mjs" }
    },
    "./package.json": "./package.json"
  },
  "sideEffects": false
}
```

Make `src/index.ts`, `src/node.ts`, and `src/browser.ts` side-effect-free export modules. Move `program.parseAsync` into an exported `runCli(argv)` in `src/cli.ts`; call it only from `bin/paws-agent.mjs`.

- [ ] **Step 4: Update workspace and repository references mechanically**

Replace package-directory and workspace references with `packages/paws-agent` and `@wangjs-jacky/paws-agent`. Keep legacy wire identifiers and compatible storage paths unchanged.

- [ ] **Step 5: Install, build, and run the focused test**

Run: `pnpm install && pnpm --filter @wangjs-jacky/paws-agent build && pnpm --filter @wangjs-jacky/paws-agent exec vitest run src/package-entry.test.ts`

Expected: build succeeds and the import-safety test passes.

- [ ] **Step 6: Commit the package boundary**

```bash
git add packages/paws-agent pnpm-workspace.yaml package.json Dockerfile pnpm-lock.yaml
git commit -m "refactor(agent): establish paws agent package entries"
```

---

### Task 2: Replace Node-only encryption with a browser-safe implementation

**Files:**
- Create: `packages/paws-agent/src/crypto/encryption.ts`
- Create: `packages/paws-agent/src/crypto/records.ts`
- Test: `packages/paws-agent/src/crypto/encryption.test.ts`
- Modify: `packages/paws-agent/src/api.ts`
- Modify: `packages/paws-agent/src/session.ts`
- Modify: `packages/paws-agent/tsconfig.json`

**Interfaces:**
- Produces: synchronous `encrypt`, `decrypt`, `deriveContentKeyPair`, and `authChallenge` browser-safe functions plus record-key resolution.
- Consumes: `globalThis.crypto.getRandomValues`, Noble Ciphers/Hashes, StableLib Base64, and TweetNaCl for legacy secretbox/box compatibility.

- [ ] **Step 1: Move existing deterministic vectors into the new crypto test**

The test must compare the new implementation against fixed legacy and AES-GCM payloads already covered by `encryption.test.ts`:

```ts
it('decrypts an existing data-key vector', () => {
    const result = decryptWithDataKey(DATA_KEY_BUNDLE, DATA_KEY);
    expect(result).toEqual({ role: 'user', content: { type: 'text', text: 'hello' } });
});
```

- [ ] **Step 2: Run the new test before implementation**

Run: `pnpm --filter @wangjs-jacky/paws-agent exec vitest run src/crypto/encryption.test.ts`

Expected: failure because the new crypto modules do not exist.

- [ ] **Step 3: Implement synchronous browser-safe primitives**

Use `globalThis.crypto.getRandomValues`, Noble HMAC/SHA-512, Noble AES-GCM, and StableLib Base64. Preserve the byte bundle exactly. This keeps the established synchronous protocol API and avoids an unnecessary async ripple through realtime handlers:

```ts
const encrypted = gcm(dataKey, nonce).encrypt(plaintext);
const bundle = new Uint8Array(1 + nonce.length + encrypted.length);
bundle[0] = 0;
bundle.set(nonce, 1);
bundle.set(encrypted, 13);
```

Use browser-safe base64 conversion without `Buffer` in the root import graph. Continue using TweetNaCl for legacy secretbox, key pairs, signing, and box operations.

- [ ] **Step 4: Replace Node EventEmitter and preserve synchronous realtime decoding**

Use a small browser-safe emitter with the existing `on`/`once`/`off` surface. Keep Socket.IO update decoding synchronous and convert failures to sanitized SDK errors.

- [ ] **Step 5: Run crypto, API, and session regressions**

Run: `pnpm --filter @wangjs-jacky/paws-agent exec vitest run src/crypto/encryption.test.ts src/api.test.ts src/session.test.ts`

Expected: all vectors and compatibility behavior pass.

- [ ] **Step 6: Commit browser-safe crypto**

```bash
git add packages/paws-agent/src/crypto packages/paws-agent/src/api.ts packages/paws-agent/src/session.ts packages/paws-agent/tsconfig.json
git commit -m "refactor(agent): make encryption browser safe"
```

---

### Task 3: Define the public domain, errors, and HTTP transport

**Files:**
- Create: `packages/paws-agent/src/client/types.ts`
- Create: `packages/paws-agent/src/client/errors.ts`
- Create: `packages/paws-agent/src/transport/http.ts`
- Create: `packages/paws-agent/src/resources/machines.ts`
- Test: `packages/paws-agent/src/client/errors.test.ts`
- Test: `packages/paws-agent/src/transport/http.test.ts`
- Test: `packages/paws-agent/src/resources/machines.test.ts`

**Interfaces:**
- Produces: public `Machine`, `Session`, `Message`, `AgentRequest`, `PawsAgentError`, `PawsHttpTransport`, and `MachinesResource`.
- Consumes: `CredentialProvider` and record decryption from Task 2.

- [ ] **Step 1: Write failures for stable errors and secret redaction**

```ts
it('normalizes 401 without leaking authorization data', () => {
    const error = normalizeHttpError(makeAxiosError(401, { token: 'secret-value' }));
    expect(error.code).toBe('AUTH_EXPIRED');
    expect(JSON.stringify(error)).not.toContain('secret-value');
});
```

- [ ] **Step 2: Run the focused failures**

Run: `pnpm --filter @wangjs-jacky/paws-agent exec vitest run src/client/errors.test.ts src/transport/http.test.ts`

Expected: failure because public errors and transport do not exist.

- [ ] **Step 3: Implement public domain types and error normalization**

Implement `PawsAgentError extends Error` with `code`, optional safe `details`, and a non-enumerable `cause`. Map 401, 403, 404, timeout, offline RPC, archive, directory approval, protocol, and decryption failures to the exact spec codes.

- [ ] **Step 4: Implement the authenticated HTTP transport**

```ts
export class PawsHttpTransport {
    constructor(private readonly options: {
        serverUrl: string;
        credentials: CredentialProvider;
        client?: AxiosInstance;
    }) {}

    get<T>(path: string): Promise<T>;
    post<T>(path: string, body: unknown): Promise<T>;
    delete(path: string): Promise<void>;
}
```

The transport loads credentials per request, adds the existing compatibility client header, removes trailing server URL slashes, URL-encodes identifiers, and never includes response bodies in public errors.

- [ ] **Step 5: Implement `MachinesResource` over transport and record crypto**

Return SDK-owned machine objects with decrypted metadata and encryption material retained only in a private internal record map.

- [ ] **Step 6: Run focused and old API regressions**

Run: `pnpm --filter @wangjs-jacky/paws-agent exec vitest run src/client/errors.test.ts src/transport/http.test.ts src/resources/machines.test.ts src/api.test.ts`

Expected: all pass.

- [ ] **Step 7: Commit domain and HTTP transport**

```bash
git add packages/paws-agent/src/client packages/paws-agent/src/transport/http.ts packages/paws-agent/src/resources/machines.ts
git commit -m "feat(agent): add typed http control surface"
```

---

### Task 4: Implement typed realtime, resources, and `PawsAgentClient`

**Files:**
- Create: `packages/paws-agent/src/client/events.ts`
- Create: `packages/paws-agent/src/transport/realtime.ts`
- Create: `packages/paws-agent/src/resources/sessions.ts`
- Create: `packages/paws-agent/src/resources/messages.ts`
- Create: `packages/paws-agent/src/resources/requests.ts`
- Create: `packages/paws-agent/src/client/PawsAgentClient.ts`
- Modify: `packages/paws-agent/src/index.ts`
- Test: `packages/paws-agent/src/client/events.test.ts`
- Test: `packages/paws-agent/src/transport/realtime.test.ts`
- Test: `packages/paws-agent/src/client/PawsAgentClient.test.ts`

**Interfaces:**
- Produces: the public API defined in the spec.
- Consumes: public types/errors, HTTP transport, browser-safe crypto, and private record maps.

- [ ] **Step 1: Write lifecycle, subscription, reconnect, and disposal failures**

```ts
it('resynchronizes before emitting ready after reconnect', async () => {
    socket.simulateReconnect();
    await flushPromises();
    expect(events.map(event => event.type === 'connection' && event.state)).toEqual([
        'connecting', 'ready', 'reconnecting', 'ready',
    ]);
    expect(http.get).toHaveBeenCalledWith('/v1/sessions');
});
```

Also assert idempotent unsubscribe and that `dispose()` closes sockets, cancels timers, and prevents later callbacks.

- [ ] **Step 2: Run focused tests and confirm missing modules**

Run: `pnpm --filter @wangjs-jacky/paws-agent exec vitest run src/client/events.test.ts src/transport/realtime.test.ts src/client/PawsAgentClient.test.ts`

Expected: failure because the realtime and client modules do not exist.

- [ ] **Step 3: Implement typed subscription and realtime state**

Use a private `Set<PawsAgentEventListener>`. Catch listener exceptions and route them to the injected logger without stopping delivery to other listeners.

The realtime transport owns one caller socket plus session subscriptions, applies bounded exponential reconnect delay, refreshes HTTP snapshots after reconnect, and emits `ready` only after refresh succeeds.

- [ ] **Step 4: Implement session and message resources**

Move list/create/history/spawn/resume/stop behavior from the old functions. Generate a stable `localId` before send and return it in `SendMessageReceipt` so retry reconciliation remains observable.

- [ ] **Step 5: Implement request approval and rejection from the existing session request protocol**

Reuse the request-response event shape already consumed by Paws App. Validate session/request IDs and convert a stale or absent request into `NOT_FOUND`.

- [ ] **Step 6: Compose the public client and exports**

```ts
export class PawsAgentClient {
    readonly machines: MachinesResource;
    readonly sessions: SessionsResource;
    readonly messages: MessagesResource;
    readonly requests: RequestsResource;

    subscribe(listener: PawsAgentEventListener): () => void;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    dispose(): Promise<void>;
}
```

Export only public contracts from `src/index.ts`.

- [ ] **Step 7: Run realtime, client, session, and machine RPC regressions**

Run: `pnpm --filter @wangjs-jacky/paws-agent exec vitest run src/client src/transport/realtime.test.ts src/resources src/session.test.ts`

Expected: all pass without open-handle warnings.

- [ ] **Step 8: Commit the public SDK**

```bash
git add packages/paws-agent/src/client packages/paws-agent/src/transport packages/paws-agent/src/resources packages/paws-agent/src/index.ts
git commit -m "feat(agent): expose paws agent client sdk"
```

---

### Task 5: Add Node and browser credential adapters

**Files:**
- Create: `packages/paws-agent/src/adapters/nodeCredentials.ts`
- Create: `packages/paws-agent/src/adapters/browserCredentials.ts`
- Modify: `packages/paws-agent/src/node.ts`
- Modify: `packages/paws-agent/src/browser.ts`
- Test: `packages/paws-agent/src/adapters/nodeCredentials.test.ts`
- Test: `packages/paws-agent/src/adapters/browserCredentials.test.ts`

**Interfaces:**
- Produces: `FileCredentialProvider`, `BrowserCredentialProvider`, `KeyValueStorage`.
- Consumes: `CredentialProvider` and `PawsCredentials` from the public SDK.

- [ ] **Step 1: Write adapter contract tests**

```ts
it('round-trips credentials without exposing raw bytes in JSON logs', async () => {
    const provider = new BrowserCredentialProvider(memoryStorage, 'paws-agent.credentials');
    await provider.setCredentials(credentials);
    expect(await provider.getCredentials()).toEqual(credentials);
    expect(JSON.stringify(provider)).not.toContain(credentials.token);
});
```

- [ ] **Step 2: Run adapter failures**

Run: `pnpm --filter @wangjs-jacky/paws-agent exec vitest run src/adapters`

Expected: failure because adapters do not exist.

- [ ] **Step 3: Implement the Node adapter with compatibility lookup**

The constructor accepts an explicit path. The default factory respects `PAWS_HOME_DIR`, then the legacy compatible environment/path already used by the control CLI. Writes use directory mode `0700` and file mode `0600`.

- [ ] **Step 4: Implement the browser adapter over injected storage**

```ts
export interface KeyValueStorage {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
}
```

Do not import `chrome`, DOM globals, or application state directly; the future extension provides a wrapper around `chrome.storage.local`.

- [ ] **Step 5: Run adapters and build each subpath**

Run: `pnpm --filter @wangjs-jacky/paws-agent exec vitest run src/adapters && pnpm --filter @wangjs-jacky/paws-agent build`

Expected: all pass; root and browser output contain no Node credential code.

- [ ] **Step 6: Commit platform adapters**

```bash
git add packages/paws-agent/src/adapters packages/paws-agent/src/node.ts packages/paws-agent/src/browser.ts
git commit -m "feat(agent): add node and browser credential adapters"
```

---

### Task 6: Make `paws-agent` a thin SDK consumer

**Files:**
- Modify: `packages/paws-agent/src/cli.ts`
- Create: `packages/paws-agent/src/cli/output.ts`
- Modify: `packages/paws-agent/bin/paws-agent.mjs`
- Modify: `packages/paws-agent/src/index.test.ts`
- Modify: `packages/paws-agent/src/cli-smoke.test.ts`
- Modify: `packages/paws-agent/src/output.test.ts`
- Remove after migration: `packages/paws-agent/src/api.ts`
- Remove after migration: `packages/paws-agent/src/machineRpc.ts`
- Remove after migration: `packages/paws-agent/src/session.ts`
- Remove after migration: `packages/paws-agent/src/output.ts`

**Interfaces:**
- Consumes: `PawsAgentClient`, `FileCredentialProvider`, and public SDK types only.
- Produces: `createCli(deps)` for tests and `runCli(argv)` for the executable wrapper.

- [ ] **Step 1: Rewrite CLI tests around injected SDK methods**

```ts
it('send delegates to the SDK and prints JSON only on stdout', async () => {
    sdk.messages.send.mockResolvedValue({ localId: 'local-1' });
    const result = await runCliForTest(['send', 'session-1', 'hello', '--json']);
    expect(sdk.messages.send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-1',
        text: 'hello',
    }));
    expect(result.stdout).toBe('{"localId":"local-1"}\n');
    expect(result.stderr).toBe('');
});
```

- [ ] **Step 2: Run CLI tests against the old implementation**

Run: `pnpm --filter @wangjs-jacky/paws-agent exec vitest run src/index.test.ts src/cli-smoke.test.ts`

Expected: failure because the old CLI constructs HTTP and session clients directly.

- [ ] **Step 3: Implement `createCli` and `runCli` with dependency injection**

All commands resolve prefixes and format output but call only public SDK resources. `--json` writes data to stdout; operational diagnostics use stderr. Map invalid Commander usage to exit `2` and SDK failures to exit `1`.

- [ ] **Step 4: Update user-visible branding and the executable wrapper**

Set Commander name/version from `@wangjs-jacky/paws-agent` metadata and emit `sentFrom: 'paws-agent'` through SDK input metadata. Remove user-visible instructions that invoke the old command.

- [ ] **Step 5: Delete duplicate transport implementations after all CLI commands migrate**

Confirm no CLI module imports Axios, Socket.IO, or crypto directly:

Run: `rg -n "axios|socket.io-client|/crypto/|encrypt\(|decrypt\(" packages/paws-agent/src/cli.ts packages/paws-agent/src/cli`

Expected: no matches.

- [ ] **Step 6: Run all CLI and SDK unit tests**

Run: `pnpm --filter @wangjs-jacky/paws-agent test`

Expected: all unit tests pass.

- [ ] **Step 7: Commit the thin CLI**

```bash
git add packages/paws-agent
git commit -m "refactor(agent): make paws agent cli consume sdk"
```

---

### Task 7: Prove the packed package in Node and Chromium

**Files:**
- Create: `packages/paws-agent/scripts/verify-pack.mjs`
- Create: `packages/paws-agent/test/consumer/esm/package.json`
- Create: `packages/paws-agent/test/consumer/esm/index.mjs`
- Create: `packages/paws-agent/test/consumer/cjs/package.json`
- Create: `packages/paws-agent/test/consumer/cjs/index.cjs`
- Create: `packages/paws-agent/test/browser/index.html`
- Create: `packages/paws-agent/test/browser/main.ts`
- Create: `packages/paws-agent/test/browser/browser.test.ts`
- Modify: `packages/paws-agent/package.json`

**Interfaces:**
- Consumes: the exact `pnpm pack` tarball.
- Produces: tarball path, SHA-256 checksum, ESM/CJS/browser/CLI smoke evidence.

- [ ] **Step 1: Write a verifier that initially fails on the incomplete package**

The script must reject unexpected files, missing declaration exports, import-time output, Node built-ins in the browser bundle, and a CLI version mismatch.

- [ ] **Step 2: Run the verifier before adding package fixes**

Run: `pnpm --filter @wangjs-jacky/paws-agent verify:pack`

Expected: failure listing the first unmet packed-artifact contract.

- [ ] **Step 3: Implement isolated ESM and CJS consumers**

Each consumer installs the tarball into a fresh temporary directory and asserts:

```js
const sdk = await import('@wangjs-jacky/paws-agent');
if (typeof sdk.PawsAgentClient !== 'function') throw new Error('missing client');
```

Capture stdout/stderr and fail if import produces output.

- [ ] **Step 4: Implement Chromium bundle and runtime verification**

Bundle `test/browser/main.ts`, open it in repository Chromium, construct the SDK with memory credentials and a mocked transport endpoint, and assert the page reports `ready`. Inspect the bundle for `node:`, `Buffer`, `process.env`, and CLI strings.

- [ ] **Step 5: Add `publint`, declaration, CLI, dry-run, and checksum checks**

The verifier runs `npm publish --dry-run --json`, `publint`, `paws-agent --help`, `paws-agent --version`, and SHA-256 generation against the same tarball.

- [ ] **Step 6: Run the complete package verifier**

Run: `pnpm --filter @wangjs-jacky/paws-agent verify:pack`

Expected: all packed ESM/CJS/browser/CLI checks pass and the script prints the tarball plus checksum.

- [ ] **Step 7: Commit artifact verification**

```bash
git add packages/paws-agent/scripts packages/paws-agent/test packages/paws-agent/package.json pnpm-lock.yaml
git commit -m "test(agent): verify packed node and browser consumers"
```

---

### Task 8: Migrate and expand isolated end-to-end coverage

**Files:**
- Rename: `packages/paws-agent/src/happy-agent.integration.test.ts` → `packages/paws-agent/src/paws-agent.integration.test.ts`
- Modify: `packages/paws-agent/vitest.integration.config.ts`
- Modify: `environments/environments.ts`
- Modify: `docs/plans/agent-testing-layers.md`
- Test: `packages/paws-agent/src/paws-agent.integration.test.ts`

**Interfaces:**
- Consumes: packed/local `paws-agent`, authenticated local Paws Server, daemon RPC, deterministic fixture agent.
- Produces: full machine/session/message/request/history/stop evidence without vendor cost.

- [ ] **Step 1: Rename the existing suite and make it invoke `paws-agent`**

Keep real server and daemon RPC coverage. Replace old binary/package references and ensure fixture paths are temporary and explicit.

- [ ] **Step 2: Add disconnect, duplicate-send, approval, and archived-session cases**

Use deterministic fixtures and assert stable SDK error codes rather than error-message substrings.

- [ ] **Step 3: Run the isolated integration suite**

Run: `pnpm --filter @wangjs-jacky/paws-agent test:integration`

Expected: authentication fixture, machine list, spawn, send, state, response, approval, history, reconnect, and stop pass without real vendor access.

- [ ] **Step 4: Run the package verifier after integration changes**

Run: `pnpm --filter @wangjs-jacky/paws-agent verify:pack`

Expected: packed-artifact checks remain green.

- [ ] **Step 5: Commit end-to-end coverage**

```bash
git add packages/paws-agent environments/environments.ts docs/plans/agent-testing-layers.md
git commit -m "test(agent): cover isolated paws agent control flow"
```

---

### Task 9: Add PR and deferred npm release workflows

**Files:**
- Create: `.github/workflows/paws-agent-ci.yml`
- Create: `.github/workflows/paws-agent-npm-publish.yml`
- Create: `packages/paws-agent/scripts/release-contract.mjs`
- Modify: `packages/paws-agent/package.json`
- Modify: `README.md`
- Modify: `README_CN.md`
- Modify: `docs/getting-started.md`
- Modify: `docs/getting-started.zh-CN.md`
- Modify: relevant Paws App and CLI user-visible command references

**Interfaces:**
- Produces: required PR gates and tag-gated release contract.
- Consumes: package build/test/verify scripts and exact tarball from Tasks 7–8.

- [ ] **Step 1: Add release-contract unit tests**

Test exact matches among tag `paws-agent-v0.1.0-beta.1`, `package.json` version, expected npm dist-tag `next`, and commit source. Stable `0.1.0` must map to `latest`; mismatches must exit nonzero.

- [ ] **Step 2: Implement PR CI**

Create jobs for Node 20/24 unit tests, Linux/macOS/Windows packed consumers, Chromium verification, and isolated integration. Add path triggers for the package, shared wire, relevant daemon/server contracts, lockfile, and workflow.

- [ ] **Step 3: Implement the publish workflow without a manual approval job**

Use GitHub-hosted Node 24 with `id-token: write`, non-cancelling concurrency, frozen install, all release gates, one packed tarball, exact-version existence checks, beta/stable dist-tag selection, registry install tests, and GitHub Release evidence.

Until npm recovery completes, validate workflow syntax and the release contract locally/through PR CI but do not create a release tag.

- [ ] **Step 4: Update Paws-facing documentation and commands**

Document workspace/link development, tarball verification, the Paws-owned-client support boundary, Node/browser examples, and current npm publication status. Do not claim registry availability before it exists.

- [ ] **Step 5: Run workflow-adjacent and documentation checks**

Run:

```bash
pnpm --filter @wangjs-jacky/paws-agent test
pnpm --filter @wangjs-jacky/paws-agent verify:pack
pnpm --filter @wangjs-jacky/paws-agent test:integration
git diff --check
```

Expected: all pass and no user-visible old control-client command remains outside explicit legacy compatibility notes.

- [ ] **Step 6: Commit CI, release, and docs**

```bash
git add .github/workflows packages/paws-agent README.md README_CN.md docs packages/happy-app packages/happy-cli pnpm-lock.yaml
git commit -m "ci(agent): add paws agent verification and release flow"
```

---

### Task 10: Final local delivery, independent review, and PR

**Files:**
- Modify as findings require: files in Tasks 1–9 only
- Produce: packed tarball and SHA-256 under a temporary artifact directory outside git
- Produce: GitHub PR with `Visible UI cases: 0`

**Interfaces:**
- Consumes: complete branch, source tests, packed artifact, isolated integration, CI workflows.
- Produces: review-clean PR, local link, exact tarball/checksum, CI evidence, and a deferred registry checkpoint.

- [ ] **Step 1: Run the complete fresh verification matrix**

```bash
pnpm install --frozen-lockfile
pnpm --filter @wangjs-jacky/paws-agent typecheck
pnpm --filter @wangjs-jacky/paws-agent test
pnpm --filter @wangjs-jacky/paws-agent verify:pack
pnpm --filter @wangjs-jacky/paws-agent test:integration
git diff --check main...HEAD
```

Expected: all pass.

- [ ] **Step 2: Perform independent API, security, package, and test review**

Review public API stability, import graph, secret handling, reconnect/dispose behavior, tarball contents, workflow permissions, release idempotency, and whether tests exercise the packed artifact. Fix every blocking or important finding and rerun affected gates.

- [ ] **Step 3: Install the local CLI link and verify it resolves to this worktree**

Use pnpm's package link mechanism from `packages/paws-agent`, then run `paws-agent --version` and resolve the executable/package path. Do not restart the Paws daemon because this control CLI is not the daemon runtime.

- [ ] **Step 4: Create the exact local delivery artifact**

Pack into a fresh temporary directory, record filename, version, SHA-256, ESM/CJS/browser/CLI verification results, and explicitly mark npm/OIDC/registry tests pending account recovery.

- [ ] **Step 5: Push the branch and create the PR**

Use the repository PR template, `Visible UI cases: 0`, test commands/results, package checksum, support boundary, release deferral, and no visual evidence requirement because this project has no user-visible UI changes.

- [ ] **Step 6: Wait for and repair actual PR CI**

Inspect every required run, fix failures, push updates, and rerun local gates affected by each fix. Confirm the PR body remains accurate at final head.

- [ ] **Step 7: Merge and verify repository release side effects**

Merge through the PR after review and CI. Verify the mandatory Web deployment run for the merge commit. Report OTA as triggered, skipped for native sensitivity, or not triggered according to actual workflow evidence.

- [ ] **Step 8: Preserve the npm recovery checkpoint**

Record that the next automatic step after account recovery is package bootstrap and Trusted Publisher configuration, followed by beta and stable workflows. Do not create a tag or claim npm delivery while credentials are unavailable.

- [ ] **Step 9: Run Durable efficiency audit**

Audit actual retries, CI failures, package issues, and reviewer findings. Retain only evidence-backed workflow or skill improvements and verify any retained change.
