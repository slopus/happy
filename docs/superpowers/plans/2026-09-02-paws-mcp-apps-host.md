# Paws MCP Apps Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render standards-compliant MCP Apps inside Paws conversations while Codex app-server remains the sole owner of MCP transport, authentication, connector selection, tool policy, and resource provenance.

**Architecture:** Extend the existing additive session tool lifecycle with an MCP App descriptor and structured result, keep a session-local authority registry in Paws CLI, expose only bounded encrypted session RPCs keyed by `callId`, and mount one frame-agnostic `McpAppHost` through native and Web sandbox adapters. Native uses an existing React Native WebView plus an inner sandboxed iframe; Web uses a different-origin Sandbox Proxy plus an inner iframe and remains disabled until that origin is deployed and verified.

**Tech Stack:** TypeScript 5.9, Zod 4, Codex app-server JSON-RPC, Socket.IO encrypted session RPC, React 19, React Native/Expo, `react-native-webview`, `@modelcontextprotocol/ext-apps`, MCP TypeScript SDK, Fastify 5, Vitest 3, Playwright 1.61, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-02-paws-mcp-apps-host-design.md`

## Global Constraints

- The root workspace `~/jacky-github/happy` stays clean on `main` and exactly aligned with `origin/main`. Execute every PR in a sibling worktree.
- Deliver the implementation as four ordered PRs. Use branches `feat/mcp-apps-protocol`, `feat/mcp-apps-native-host`, `feat/mcp-apps-interactive`, and `feat/mcp-apps-web-host`; start each branch from the newly merged preceding PR on `main`.
- Do not connect Paws App directly to any MCP server. A View request contains a `callId`, URI, or tool name only; CLI derives thread, server, connector, and origin authority from immutable binding state.
- Do not put HTML, tool arguments/results, `_meta`, resource URIs, connector IDs, link IDs, App names, or raw MCP errors in normal logs or analytics.
- Keep wire changes additive and optional. Existing Session Protocol v1 events and stable event IDs must continue to parse and replay unchanged.
- Keep raw App HTML out of conversation history. It is fetched lazily, transferred over encrypted session RPC, held in bounded memory, and destroyed on teardown or expiry.
- Do not add an Expo plugin or native module. The existing `react-native-webview` dependency is the only native frame dependency. Do not change Android package names, OTA channels, or runtime versions.
- The runtime contract remains development `build.paws.dev` / preview / 22, preview `build.paws.preview` / preview / 22, production `build.paws` / production / 23. Run the contract test in every App-facing PR.
- Do not start Expo, a simulator, an emulator, a dev server, Tauri, OTA publishing, deployment, or real-device validation without the user's explicit execution confirmation. Static checks and unit tests are always allowed.
- Web Apps remain feature-disabled unless `EXPO_PUBLIC_MCP_APP_SANDBOX_ORIGIN` is a valid different HTTPS origin and the deployed sandbox self-test passes. `http://localhost` is accepted only in development.
- Every user-facing string must use the existing translation system and every color/spacing choice must use semantic Unistyles tokens.
- Every task below ends with a narrow commit. Do not squash the task commits while the PR is under review.

## Target File Structure

### Shared protocol

- `packages/happy-wire/src/sessionProtocol.ts` — canonical MCP App Zod schemas, inferred types, active v1 compatibility policy.
- `packages/happy-wire/src/sessionProtocol.test.ts` — old/new client compatibility, bounds, malformed payload, and round-trip tests.
- `packages/happy-wire/src/index.ts` — public exports consumed by CLI and App.

### Codex CLI adapter and authority

- `packages/happy-cli/src/codex/codexAppServerTypes.ts` — narrow compatibility types for capability negotiation, MCP UI metadata, resource reads, tool calls, and catalog annotations.
- `packages/happy-cli/src/codex/codexAppServerClient.ts` — extended initialize with one reconnect fallback, live `mcpToolCall` notifications, and typed resource/tool methods.
- `packages/happy-cli/src/codex/utils/sessionProtocolMapper.ts` — identical live/history MCP App envelopes and size-safe result mapping.
- `packages/happy-cli/src/codex/mcpApps/CodexMcpAppAdapter.ts` — normalize Codex version drift and enforce origin-scoped reads/catalog policy.
- `packages/happy-cli/src/codex/mcpApps/McpAppBindingRegistry.ts` — immutable session-local `callId` authority plus bounded resource capability store.
- `packages/happy-cli/src/codex/mcpApps/registerMcpAppRpcHandlers.ts` — four encrypted RPC handlers and cleanup.
- `packages/happy-cli/src/codex/runCodex.ts` — construct registry/adapter, register handlers, route permission requests, and dispose state.
- Colocated `*.test.ts` files — compatibility, replay, authority, chunking, cleanup, and permission tests.

### Paws App host

- `packages/happy-app/sources/sync/typesRaw.ts` — import the shared event schemas and preserve MCP App fields through legacy normalization.
- `packages/happy-app/sources/sync/typesMessage.ts` — attach presentation/result to `ToolCall`.
- `packages/happy-app/sources/sync/reducer/reducer.ts` — merge start/end MCP App data into one tool model.
- `packages/happy-app/sources/sync/ops.mcpApps.ts` — typed session RPC wrappers.
- `packages/happy-app/sources/components/tools/McpAppHost.tsx` — lifecycle/state rendering only.
- `packages/happy-app/sources/components/tools/mcpApps/types.ts` — host, frame, error, context, and bridge interfaces.
- `packages/happy-app/sources/components/tools/mcpApps/remotePort.ts` — chunk assembly, offset/length/SHA-256 verification, and RPC error normalization.
- `packages/happy-app/sources/components/tools/mcpApps/hostController.ts` — deterministic lifecycle ordering, buffering, timeout, retry, and teardown.
- `packages/happy-app/sources/components/tools/mcpApps/NativeMcpAppFrameAdapter.native.ts` — narrow React Native WebView adapter.
- `packages/happy-app/sources/components/tools/mcpApps/WebMcpAppFrameAdapter.web.ts` — exact-origin Web Sandbox Proxy adapter.
- `packages/happy-app/sources/components/tools/mcpApps/UnsupportedMcpAppFrameAdapter.ts` — static fallback for unsupported platforms/configuration.
- `packages/happy-app/sources/components/tools/ToolView.tsx` — retain header/status and mount `McpAppHost` only when `tool.mcpApp` exists.
- `packages/happy-app/mcp-app-sandbox/hostShell.ts` — browser Host Shell entry using the official AppBridge.
- `packages/happy-app/scripts/build-mcp-app-host-shell.cjs` — deterministic browser bundle generator used by native and server delivery.
- `packages/happy-app/sources/components/tools/mcpApps/generated/hostShellBundle.ts` — committed generated bundle imported by native.
- Colocated `*.test.ts`/`*.test.tsx` files — lifecycle, bridge, reducer, frame, accessibility, translation, and security tests.

### Different-origin Web sandbox

- `packages/happy-server/sources/app/api/routes/mcpAppSandboxRoutes.ts` — sandbox-host-only HTML/JS routes with no-store security headers.
- `packages/happy-server/sources/app/api/mcpAppSandboxSecurity.ts` — allowlisted parent-origin, host, CSP, and referrer helpers.
- `packages/happy-server/sources/app/api/generated/mcpAppHostShellAssets.ts` — committed generated Sandbox Proxy HTML and external JavaScript.
- `packages/happy-server/sources/app/api/api.ts` — register the isolated route before SPA fallback.
- `packages/happy-server/sources/app/api/routes/mcpAppSandboxRoutes.spec.ts` — Fastify injection tests for headers and origin rejection.
- `packages/happy-app/e2e/mcp-app-host-evidence.spec.ts` — real-origin isolation, lifecycle, and security evidence.

---

## PR 1 — Protocol Alignment and Lossless CLI Events

Visible UI cases: `0`.

### Task 1: Add the canonical additive wire contract

**Files:**

- Modify: `packages/happy-wire/src/sessionProtocol.ts`
- Modify: `packages/happy-wire/src/sessionProtocol.test.ts`
- Modify: `packages/happy-wire/src/index.ts`

**Interfaces:**

- Consumes: existing `sessionToolCallStartEventSchema`, `sessionToolCallEndEventSchema`, and `sessionEnvelopeSchema`.
- Produces: `McpAppPresentationV1`, `McpAppResultV1`, their Zod schemas, and optional `mcpApp`/`mcpAppResult` event fields.
- Invariant: old payloads parse byte-for-byte as before; new fields are ignored by old clients and required breaking changes remain out of v1.

- [ ] **Step 1: Write the compatibility tests first.**

Add fixtures that parse an old start/end event, round-trip a new descriptor/result, reject a non-`ui://` URI, reject a descriptor string beyond its limit, and reject an unavailable result with any code other than `MCP_APP_RESULT_TOO_LARGE`.

```ts
it('round-trips optional MCP App data without changing legacy events', () => {
    const parsed = sessionEnvelopeSchema.parse({
        id: 'event-1',
        time: 1,
        role: 'agent',
        ev: {
            t: 'tool-call-start',
            call: 'call-1',
            name: 'mcp__demo__show',
            title: 'Demo',
            description: 'Show demo',
            args: {},
            mcpApp: {
                version: 1,
                server: 'demo',
                resourceUri: 'ui://demo/index.html',
                appName: 'Demo App',
            },
        },
    });
    expect(parsed.ev).toMatchObject({
        t: 'tool-call-start',
        mcpApp: { version: 1, resourceUri: 'ui://demo/index.html' },
    });
});
```

- [ ] **Step 2: Run the focused test and confirm it fails because `mcpApp` is stripped or unavailable.**

Run: `pnpm --filter @slopus/happy-wire exec vitest run src/sessionProtocol.test.ts`

Expected: FAIL on the new property/type assertions; legacy fixtures remain green.

- [ ] **Step 3: Implement and export the schemas.**

Use conservative explicit limits and a discriminated result union:

```ts
export const mcpAppPresentationV1Schema = z.object({
    version: z.literal(1),
    server: z.string().min(1).max(256),
    resourceUri: z.string().min(6).max(2048).refine((value) => value.startsWith('ui://')),
    appName: z.string().min(1).max(160).optional(),
    actionName: z.string().min(1).max(160).optional(),
});

export const mcpAppResultV1Schema = z.discriminatedUnion('state', [
    z.object({
        version: z.literal(1),
        state: z.literal('available'),
        content: z.array(z.unknown()),
        structuredContent: z.unknown().optional(),
        _meta: z.unknown().optional(),
    }),
    z.object({
        version: z.literal(1),
        state: z.literal('unavailable'),
        code: z.literal('MCP_APP_RESULT_TOO_LARGE'),
    }),
]);

export type McpAppPresentationV1 = z.infer<typeof mcpAppPresentationV1Schema>;
export type McpAppResultV1 = z.infer<typeof mcpAppResultV1Schema>;
```

Attach these with `.optional()` to the two existing event schemas. Replace the stale unused/frozen header with the active v1 policy described in the spec.

- [ ] **Step 4: Run the focused test and typecheck.**

Run:

```bash
pnpm --filter @slopus/happy-wire exec vitest run src/sessionProtocol.test.ts
pnpm --filter @slopus/happy-wire typecheck
```

Expected: both PASS.

- [ ] **Step 5: Commit the wire contract.**

```bash
git add packages/happy-wire/src/sessionProtocol.ts packages/happy-wire/src/sessionProtocol.test.ts packages/happy-wire/src/index.ts
git commit -m "feat(wire): add MCP App tool event fields"
```

### Task 2: Negotiate MCP UI capability with one legacy reconnect fallback

**Files:**

- Modify: `packages/happy-cli/src/codex/codexAppServerTypes.ts`
- Modify: `packages/happy-cli/src/codex/codexAppServerClient.ts`
- Modify: `packages/happy-cli/src/codex/codexAppServerClient.test.ts`

**Interfaces:**

- Consumes: Codex app-server `initialize`, existing local process and shared Unix-socket connection modes.
- Produces: extended client capability `io.modelcontextprotocol/ui` and `mcpUiCapability: 'enabled' | 'legacy'` on the client.
- Invariant: never send `initialize` twice on one transport; an invalid-params response closes the transport, reconnects once, and initializes without the extension.

- [ ] **Step 1: Add failing transport tests.**

Cover successful extended initialization, local-process invalid-params fallback, shared-socket invalid-params fallback, and a second legacy failure. Assert the first request includes exactly this extension and the second transport omits it:

```ts
expect(firstInitialize.params.capabilities).toMatchObject({
    experimentalApi: true,
    extensions: {
        'io.modelcontextprotocol/ui': {
            mimeTypes: ['text/html;profile=mcp-app'],
        },
    },
});
expect(secondInitialize.params.capabilities.extensions).toBeUndefined();
```

- [ ] **Step 2: Run the focused test and confirm capability/fallback assertions fail.**

Run: `pnpm --filter @wangjs-jacky/paws exec vitest run --project unit src/codex/codexAppServerClient.test.ts`

Expected: FAIL because initialize has no `extensions` and reconnect fallback is absent.

- [ ] **Step 3: Extend the compatibility types without copying the entire generated Codex surface.**

```ts
export type McpUiClientCapability = {
    mimeTypes: Array<'text/html;profile=mcp-app'>;
};

export type InitializeParams = {
    clientInfo: { name: string; title: string | null; version: string };
    capabilities: {
        experimentalApi: boolean;
        optOutNotificationMethods?: string[] | null;
        extensions?: { 'io.modelcontextprotocol/ui': McpUiClientCapability };
    } | null;
};
```

Update the file header to record the supported Codex range rather than claiming the types are a complete 0.107 generation.

- [ ] **Step 4: Split transport opening from initialization and implement the one-shot retry.**

Use an internal attempt enum and preserve thread state only after initialization succeeds:

```ts
private async connectWithCapabilityFallback(): Promise<void> {
    try {
        await this.openTransport();
        await this.initializeConnection({ advertiseMcpUi: true });
        this.mcpUiCapability = 'enabled';
    } catch (error) {
        if (!isInvalidInitializeParams(error)) throw error;
        await this.disconnectInternal({ preserveThreadState: true });
        await this.openTransport();
        await this.initializeConnection({ advertiseMcpUi: false });
        this.mcpUiCapability = 'legacy';
    }
}
```

`isInvalidInitializeParams` must match the JSON-RPC invalid-params code, not error-message substrings.

- [ ] **Step 5: Run client tests and CLI typecheck.**

```bash
pnpm --filter @wangjs-jacky/paws exec vitest run --project unit src/codex/codexAppServerClient.test.ts
pnpm --filter @wangjs-jacky/paws typecheck
```

Expected: PASS in process and shared-socket modes; tests assert one initialize per transport.

- [ ] **Step 6: Commit capability negotiation.**

```bash
git add packages/happy-cli/src/codex/codexAppServerTypes.ts packages/happy-cli/src/codex/codexAppServerClient.ts packages/happy-cli/src/codex/codexAppServerClient.test.ts
git commit -m "feat(codex): negotiate MCP UI capability"
```

### Task 3: Normalize live and historical MCP App tool events

**Files:**

- Modify: `packages/happy-cli/src/codex/codexAppServerTypes.ts`
- Modify: `packages/happy-cli/src/codex/codexAppServerClient.ts`
- Modify: `packages/happy-cli/src/codex/utils/sessionProtocolMapper.ts`
- Modify: `packages/happy-cli/src/codex/codexAppServerClient.test.ts`
- Modify: `packages/happy-cli/src/codex/__tests__/sessionProtocolMapper.test.ts`
- Create: `packages/happy-cli/src/codex/mcpApps/CodexMcpAppAdapter.ts`
- Create: `packages/happy-cli/src/codex/mcpApps/CodexMcpAppAdapter.test.ts`

**Interfaces:**

- Consumes: Codex `ThreadItem` of type `mcpToolCall`, live `item/started`/`item/completed`, historical `thread/read`, modern/deprecated resource URI metadata.
- Produces: ordinary `tool-call-start`/`tool-call-end` envelopes with optional `mcpApp`/`mcpAppResult`, same call ID and same ordering in live and replay paths.
- Invariant: preserve `content`, `structuredContent`, and `_meta` as structured JSON; do not call `String(result)`.

- [ ] **Step 1: Add version-drift fixtures and equality tests.**

Create fixtures for current local Codex output with `templateId`, current upstream output with `readOnlyHint`, and the deprecated URI field. Assert live and replay produce the same pair after removing envelope time/id fields:

```ts
expect(stripEnvelopeIdentity(liveEnvelopes)).toEqual(
    stripEnvelopeIdentity(replayEnvelopes),
);
expect(end.ev.mcpAppResult).toEqual({
    version: 1,
    state: 'available',
    content: [{ type: 'text', text: 'done' }],
    structuredContent: { count: 1 },
    _meta: { privateViewState: 'opaque' },
});
```

- [ ] **Step 2: Run focused tests and confirm live MCP items are unhandled and replay stringifies results.**

```bash
pnpm --filter @wangjs-jacky/paws exec vitest run --project unit src/codex/codexAppServerClient.test.ts src/codex/__tests__/sessionProtocolMapper.test.ts src/codex/mcpApps/CodexMcpAppAdapter.test.ts
```

Expected: FAIL on live events, App descriptor, and structured result assertions.

- [ ] **Step 3: Define narrow tolerant compatibility types.**

```ts
export type McpToolCallAppContext = {
    resourceUri?: string | null;
    resource_uri?: string | null;
    templateId?: string | null;
    appName?: string | null;
    actionName?: string | null;
    connectorId?: string | null;
    [key: string]: unknown;
};

export type McpToolCallResult = {
    content?: unknown[];
    structuredContent?: unknown;
    _meta?: unknown;
    [key: string]: unknown;
};
```

Keep optional fields optional and retain the catch-all thread item union for future Codex versions.

- [ ] **Step 4: Implement `CodexMcpAppAdapter` as the only normalization boundary.**

Its public methods are exact and side-effect free:

```ts
export interface NormalizedCodexMcpAppCall {
    callId: string;
    server: string;
    tool: string;
    input: Record<string, unknown>;
    presentation?: McpAppPresentationV1;
    result?: McpAppResultV1;
}

export class CodexMcpAppAdapter {
    normalizeItem(item: Extract<ThreadItem, { type: 'mcpToolCall' }>): NormalizedCodexMcpAppCall;
}
```

Normalize only `ui://` presentation URIs. Serialize a candidate result once; when it exceeds 256 KiB, emit `{ version: 1, state: 'unavailable', code: 'MCP_APP_RESULT_TOO_LARGE' }` without changing the underlying tool status.

- [ ] **Step 5: Route both live and history through the adapter.**

In `handleRawNotification`, handle `mcpToolCall` before generic item fallthrough. Feed its normalized data into the existing processor path so Session Protocol event IDs still use the established call/turn inputs. In `emitHistoricalToolCall`, replace `String(item.result)` with the same adapter output.

- [ ] **Step 6: Run focused tests, wire tests, and CLI typecheck.**

```bash
pnpm --filter @wangjs-jacky/paws exec vitest run --project unit src/codex/codexAppServerClient.test.ts src/codex/__tests__/sessionProtocolMapper.test.ts src/codex/mcpApps/CodexMcpAppAdapter.test.ts
pnpm --filter @slopus/happy-wire exec vitest run src/sessionProtocol.test.ts
pnpm --filter @wangjs-jacky/paws typecheck
```

Expected: PASS; the test suite proves live/replay equivalence and result size behavior.

- [ ] **Step 7: Commit lossless event mapping.**

```bash
git add packages/happy-cli/src/codex
git commit -m "feat(codex): preserve MCP App tool events"
```

### Task 4: Build the immutable binding registry and finish PR 1

**Files:**

- Create: `packages/happy-cli/src/codex/mcpApps/McpAppBindingRegistry.ts`
- Create: `packages/happy-cli/src/codex/mcpApps/McpAppBindingRegistry.test.ts`
- Modify: `packages/happy-cli/src/codex/runCodex.ts`
- Modify: `packages/happy-cli/src/codex/utils/sessionProtocolMapper.ts`

**Interfaces:**

- Consumes: normalized live/history MCP calls and current Codex thread ID.
- Produces: lookup by `callId` only; internally retained thread/server/resource/connector authority.
- Invariant: `callId`, `threadId`, `server`, and `resourceUri` never mutate after insertion; trusted origin exists only after successful completion.

- [ ] **Step 1: Write registry tests for insertion, replay rebuild, mutation rejection, origin timing, unknown call IDs, and clear.**

```ts
expect(() => registry.bind({
    callId: 'call-1',
    threadId: 'thread-2',
    server: 'other',
    resourceUri: 'ui://demo/index.html',
    input: {},
})).toThrowError(expect.objectContaining({ code: 'MCP_APP_ORIGIN_MISMATCH' }));
```

- [ ] **Step 2: Run the new test and confirm the module does not exist.**

Run: `pnpm --filter @wangjs-jacky/paws exec vitest run --project unit src/codex/mcpApps/McpAppBindingRegistry.test.ts`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the binding type and explicit transitions.**

```ts
export type McpAppBinding = Readonly<{
    callId: string;
    threadId: string;
    server: string;
    resourceUri: string;
    input: Record<string, unknown>;
    result?: McpAppResultV1;
    trustedOriginCallId?: string;
    connectorId?: string;
    appName?: string;
    actionName?: string;
}>;

export class McpAppBindingRegistry {
    bindStarted(binding: Omit<McpAppBinding, 'result' | 'trustedOriginCallId'>): void;
    complete(callId: string, result: McpAppResultV1 | undefined, succeeded: boolean): void;
    get(callId: string): McpAppBinding;
    clear(): void;
}
```

`complete` may only add result and, when `succeeded === true` and the immutable binding has internal `connectorId` context, set `trustedOriginCallId` to the same `callId`. An ordinary configured MCP binding has no connector context and remains thread-scoped. The method must not accept a caller-supplied origin ID.

- [ ] **Step 4: Feed the registry from live and replay mapping.**

Construct one registry per Paws Codex session in `runCodex.ts`. Rebuild it while iterating `thread/read` history before RPCs are accepted. Clear it in every session termination path after aborting pending work.

- [ ] **Step 5: Run PR 1 verification.**

```bash
pnpm --filter @wangjs-jacky/paws exec vitest run --project unit src/codex/mcpApps src/codex/codexAppServerClient.test.ts src/codex/__tests__/sessionProtocolMapper.test.ts
pnpm --filter @slopus/happy-wire test
pnpm --filter @wangjs-jacky/paws typecheck
git diff --check
```

Expected: PASS. Confirm no App/UI file changed and record `Visible UI cases: 0` in the PR body.

- [ ] **Step 6: Commit the registry integration.**

```bash
git add packages/happy-cli/src/codex
git commit -m "feat(codex): bind MCP Apps to tool origins"
```

---

## PR 2 — Encrypted Resource Bridge and Read-only Native Host

Visible native cases: loading, successful read-only App, offline fallback, invalid-resource fallback.

### Task 5: Add origin-safe primary resource RPC and bounded chunk storage

**Files:**

- Modify: `packages/happy-cli/src/codex/codexAppServerTypes.ts`
- Modify: `packages/happy-cli/src/codex/codexAppServerClient.ts`
- Modify: `packages/happy-cli/src/codex/mcpApps/CodexMcpAppAdapter.ts`
- Modify: `packages/happy-cli/src/codex/mcpApps/McpAppBindingRegistry.ts`
- Create: `packages/happy-cli/src/codex/mcpApps/registerMcpAppRpcHandlers.ts`
- Create: `packages/happy-cli/src/codex/mcpApps/registerMcpAppRpcHandlers.test.ts`
- Modify: `packages/happy-cli/src/codex/runCodex.ts`

**Interfaces:**

- Consumes: encrypted `mcpAppResourceOpen({ callId })` and `mcpAppResourceChunk({ resourceId, offset })` session RPCs.
- Produces: verified metadata and fixed-size base64 chunks; no HTML in messages or logs.
- Invariant: trusted primary reads always send `originCallId = callId`; a scoped failure never retries unscoped.

All four MCP App RPC methods use a structured response envelope so the generic RPC manager never exposes raw exception strings:

```ts
export type McpAppRpcResponse<T> =
    | { ok: true; value: T }
    | { ok: false; error: { code: McpAppErrorCode; retryable: boolean; summary: string } };
```

Handlers catch Codex/internal errors locally, log only an allowlisted stable code, and return the safe envelope. App wrappers reject any legacy `{ error: string }` response as `MCP_APP_INTERNAL`.

- [ ] **Step 1: Write failing authority and chunk tests.**

Cover unknown binding, waiting-for-origin, trusted scoped read, ordinary thread-scoped read, URI/MIME mismatch, 5 MiB limit, 256 KiB chunk limit, contiguous offsets, unguessable resource IDs, 8-buffer eviction, two-minute expiry, session cleanup, and disconnect abort.

```ts
expect(client.request).toHaveBeenCalledWith('mcpServer/resource/read', {
    threadId: 'thread-1',
    server: 'demo',
    uri: 'ui://demo/index.html',
    originCallId: 'call-1',
});
expect(client.request).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Run the focused test and confirm the RPC handlers are missing.**

Run: `pnpm --filter @wangjs-jacky/paws exec vitest run --project unit src/codex/mcpApps/registerMcpAppRpcHandlers.test.ts`

Expected: FAIL with module-not-found or unregistered methods.

- [ ] **Step 3: Add narrow Codex request/response methods.**

```ts
export type McpResourceReadParams = {
    threadId: string;
    server: string;
    uri: string;
    originCallId?: string;
};

export type McpResourceReadResponse = {
    contents: Array<{
        uri: string;
        mimeType?: string;
        text?: string;
        blob?: string;
        _meta?: unknown;
    }>;
};
```

Expose typed `readMcpResource` and retain unknown response fields for Codex drift.

- [ ] **Step 4: Implement exact resource constants and capability records.**

```ts
export const MCP_APP_MAX_HTML_BYTES = 5 * 1024 * 1024;
export const MCP_APP_CHUNK_BYTES = 256 * 1024;
export const MCP_APP_MAX_ACTIVE_RESOURCES = 8;
export const MCP_APP_RESOURCE_TTL_MS = 2 * 60 * 1000;

type BufferedResource = {
    resourceId: string;
    callId: string;
    bytes: Uint8Array;
    sha256: string;
    expiresAt: number;
};
```

Generate `resourceId` with cryptographic randomness. `mcpAppResourceChunk` validates owner, offset, expiry, and returns no more than the fixed chunk size.

- [ ] **Step 5: Register handlers after client/thread setup and dispose them on termination.**

Register only `mcpAppResourceOpen` and `mcpAppResourceChunk` in this PR. Branch on immutable binding state: `connectorId` plus no `trustedOriginCallId` returns retryable `MCP_APP_ORIGIN_MISMATCH`; `trustedOriginCallId` performs the scoped read; no connector context performs the ordinary thread-scoped read. Never prefetch or retry a trusted resource unscoped.

- [ ] **Step 6: Run focused tests and CLI typecheck.**

```bash
pnpm --filter @wangjs-jacky/paws exec vitest run --project unit src/codex/mcpApps
pnpm --filter @wangjs-jacky/paws typecheck
```

Expected: PASS; tests prove no unscoped trusted retry.

- [ ] **Step 7: Commit the resource bridge.**

```bash
git add packages/happy-cli/src/codex
git commit -m "feat(codex): bridge MCP App resources over RPC"
```

### Task 6: Preserve MCP App data through App normalization and reducer state

**Files:**

- Modify: `packages/happy-app/sources/sync/typesRaw.ts`
- Modify: `packages/happy-app/sources/sync/typesRaw.spec.ts`
- Modify: `packages/happy-app/sources/sync/typesMessage.ts`
- Modify: `packages/happy-app/sources/sync/reducer/reducer.ts`
- Modify: `packages/happy-app/sources/sync/reducer/reducer.spec.ts`

**Interfaces:**

- Consumes: shared `McpAppPresentationV1` and `McpAppResultV1` from `@slopus/happy-wire`.
- Produces: `ToolCall.mcpApp?` and `ToolCall.mcpAppResult?` retained across start-first, result-first, sidechain, and replay orderings.
- Invariant: App does not redefine the touched session event schemas.

- [ ] **Step 1: Add failing normalization/reducer cases.**

```ts
expect(toolMessage.tool).toMatchObject({
    mcpApp: { version: 1, resourceUri: 'ui://demo/index.html' },
    mcpAppResult: {
        version: 1,
        state: 'available',
        structuredContent: { count: 1 },
    },
});
```

Test tool result arriving before tool start and ensure the pending result retains `mcpAppResult`.

- [ ] **Step 2: Run focused tests and confirm fields are lost.**

```bash
pnpm --filter happy-app exec vitest run sources/sync/typesRaw.spec.ts sources/sync/reducer/reducer.spec.ts
```

Expected: FAIL because normalized content and `ToolCall` omit the new fields.

- [ ] **Step 3: Import shared schemas and extend normalized content.**

Use the shared event schema at the Session Protocol envelope boundary. Preserve outer legacy preprocessors, but attach the inferred shared fields to normalized tool content:

```ts
export type ToolCall = {
    name: string;
    state: 'running' | 'completed' | 'error';
    input: unknown;
    createdAt: number;
    startedAt: number | null;
    completedAt: number | null;
    description: string | null;
    result?: unknown;
    failure?: { code?: string; summary: string; detail?: string };
    permission?: {
        id: string;
        status: 'pending' | 'approved' | 'denied' | 'canceled';
        reason?: string;
        mode?: string;
        allowedTools?: string[];
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
        date?: number;
    };
    mcpApp?: McpAppPresentationV1;
    mcpAppResult?: McpAppResultV1;
};
```

Copy `mcpApp` during Phase 2 and `mcpAppResult` through `PendingToolResult` during Phase 3. Merge only matching `callId` records.

- [ ] **Step 4: Run focused tests and App typecheck.**

```bash
pnpm --filter happy-app exec vitest run sources/sync/typesRaw.spec.ts sources/sync/reducer/reducer.spec.ts
pnpm --filter happy-app typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit App data plumbing.**

```bash
git add packages/happy-app/sources/sync
git commit -m "feat(app): retain MCP App tool metadata"
```

### Task 7: Implement the verified App remote port and deterministic host controller

**Files:**

- Create: `packages/happy-app/sources/sync/ops.mcpApps.ts`
- Create: `packages/happy-app/sources/sync/ops.mcpApps.test.ts`
- Create: `packages/happy-app/sources/components/tools/mcpApps/types.ts`
- Create: `packages/happy-app/sources/components/tools/mcpApps/remotePort.ts`
- Create: `packages/happy-app/sources/components/tools/mcpApps/remotePort.test.ts`
- Create: `packages/happy-app/sources/components/tools/mcpApps/hostController.ts`
- Create: `packages/happy-app/sources/components/tools/mcpApps/hostController.test.ts`

**Interfaces:**

- Consumes: typed `apiSocket.sessionRPC`, presentation, input, result, and injected frame adapter.
- Produces: a verified UTF-8 primary resource and deterministic lifecycle events.
- Invariant: no frame receives HTML before offset, length, and SHA-256 validation; late async work is ignored after disposal.

- [ ] **Step 1: Write failing RPC wrapper and chunk integrity tests.**

Cover contiguous offsets, repeated/skipped offset rejection, decoded byte length, SHA-256 mismatch, invalid UTF-8, timeout mapping, and cancellation.

```ts
await expect(port.readResource({ callId: 'call-1' })).rejects.toMatchObject({
    code: 'MCP_APP_INVALID_RESOURCE',
    retryable: false,
});
```

- [ ] **Step 2: Run focused tests and confirm the modules do not exist.**

```bash
pnpm --filter happy-app exec vitest run sources/sync/ops.mcpApps.test.ts sources/components/tools/mcpApps/remotePort.test.ts sources/components/tools/mcpApps/hostController.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Define the stable host seam and errors.**

```ts
export type McpAppErrorCode =
    | 'MCP_APP_UNSUPPORTED'
    | 'MCP_APP_SESSION_OFFLINE'
    | 'MCP_APP_BINDING_NOT_FOUND'
    | 'MCP_APP_ORIGIN_MISMATCH'
    | 'MCP_APP_RESOURCE_NOT_FOUND'
    | 'MCP_APP_INVALID_RESOURCE'
    | 'MCP_APP_RESOURCE_TOO_LARGE'
    | 'MCP_APP_RESULT_TOO_LARGE'
    | 'MCP_APP_TOOL_NOT_ALLOWED'
    | 'MCP_APP_PERMISSION_DENIED'
    | 'MCP_APP_SANDBOX_UNAVAILABLE'
    | 'MCP_APP_BRIDGE_PROTOCOL'
    | 'MCP_APP_TIMEOUT'
    | 'MCP_APP_INTERNAL';

export interface McpAppFrame {
    sendToolInput(input: Record<string, unknown>): void;
    sendToolResult(result: McpAppToolResult): void;
    sendToolCancelled(reason: string): void;
    updateHostContext(context: McpAppHostContext): void;
    teardown(): Promise<void>;
}

export type McpAppToolResult = {
    content: unknown[];
    structuredContent?: unknown;
    _meta?: unknown;
    isError?: boolean;
};
```

Add the `McpAppRemotePort` and `McpAppFrameAdapter` interfaces exactly as approved in the spec.

- [ ] **Step 4: Implement typed RPC wrappers and verified assembly.**

`readResource` loops while `nextOffset` exists, requires `response.offset === requestedOffset`, decodes base64 into a pre-sized byte buffer, compares total length and SHA-256, then decodes with `TextDecoder('utf-8', { fatal: true })`.

- [ ] **Step 5: Implement the controller as an explicit state machine.**

```ts
export type McpAppHostState =
    | { type: 'fallback' }
    | { type: 'waiting-for-origin' }
    | { type: 'loading-resource' }
    | { type: 'loading-sandbox' }
    | { type: 'initializing' }
    | { type: 'active' }
    | { type: 'failed'; error: McpAppHostError };
```

Enforce: resource → frame ready → initialize → input → buffered result/cancel → active. If primary open returns retryable `MCP_APP_ORIGIN_MISMATCH`, enter `waiting-for-origin` and do not poll; retry once only when `updateToolCall` observes a new terminal tool state/result. An `unavailable` result stays on the static fallback and is never sent into a frame. Use 30 seconds for resource open, 15 seconds for frame ready/initialize, one user-triggered retry only for retryable failures, and teardown in `finally`/dispose.

- [ ] **Step 6: Run focused tests and App typecheck.**

```bash
pnpm --filter happy-app exec vitest run sources/sync/ops.mcpApps.test.ts sources/components/tools/mcpApps/remotePort.test.ts sources/components/tools/mcpApps/hostController.test.ts
pnpm --filter happy-app typecheck
```

Expected: PASS; lifecycle test records exact ordered events and verifies every timer/listener is removed.

- [ ] **Step 7: Commit the host core.**

```bash
git add packages/happy-app/sources/sync/ops.mcpApps.ts packages/happy-app/sources/sync/ops.mcpApps.test.ts packages/happy-app/sources/components/tools/mcpApps
git commit -m "feat(app): add MCP App host controller"
```

### Task 8: Add the official Host Shell, native sandbox adapter, and ToolView presentation

**Files:**

- Modify: `packages/happy-app/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `packages/happy-app/mcp-app-sandbox/hostShell.ts`
- Create: `packages/happy-app/scripts/build-mcp-app-host-shell.cjs`
- Create: `packages/happy-app/sources/components/tools/mcpApps/generated/hostShellBundle.ts`
- Create: `packages/happy-app/sources/components/tools/mcpApps/NativeMcpAppFrameAdapter.native.ts`
- Create: `packages/happy-app/sources/components/tools/mcpApps/NativeMcpAppFrameAdapter.native.test.tsx`
- Create: `packages/happy-app/sources/components/tools/mcpApps/UnsupportedMcpAppFrameAdapter.ts`
- Create: `packages/happy-app/sources/components/tools/McpAppHost.tsx`
- Create: `packages/happy-app/sources/components/tools/McpAppHost.test.tsx`
- Modify: `packages/happy-app/sources/components/tools/ToolView.tsx`
- Create: `packages/happy-app/sources/components/tools/ToolView.test.tsx`
- Modify: all files under `packages/happy-app/sources/text/translations/*.ts`
- Create: `packages/happy-app/sources/text/mcpAppTranslations.test.ts`

**Interfaces:**

- Consumes: official AppBridge, generated browser Host Shell, `McpAppHost` controller, semantic theme/locale/context, existing tool header.
- Produces: a top WebView Host Shell with one inner sandboxed iframe and a narrow Zod-validated native message union.
- Invariant: View cannot reach `ReactNativeWebView`; camera, microphone, location, clipboard, file access, popups, and arbitrary navigation are denied.

- [ ] **Step 1: Add dependencies at exact reviewed versions and inspect the lockfile before coding.**

```bash
pnpm --filter happy-app add @modelcontextprotocol/ext-apps@1.7.5 @modelcontextprotocol/sdk@1.29.0
pnpm --filter happy-app add -D esbuild@0.27.2
pnpm --filter happy-app why @modelcontextprotocol/ext-apps @modelcontextprotocol/sdk
```

Verify the diff contains JavaScript packages only: no Expo config plugin, Pod, Gradle module, Android permission, or native source. If any native surface appears, stop this PR and revise the architecture rather than changing runtime 22/23.

- [ ] **Step 2: Write failing Host Shell and native frame tests.**

Test exact message variants, 256 KiB bridge limit, malformed JSON teardown, blocked top-level navigation, no generic eval/native method, sandbox attributes, clamped height, resize throttling, and disposal.

```ts
expect(innerIframe.sandbox).toEqual([
    'allow-scripts',
]);
expect(nativeMessages.safeParse({ type: 'eval', code: 'window.top.document' }).success).toBe(false);
```

- [ ] **Step 3: Run focused tests and confirm native host modules are absent.**

```bash
pnpm --filter happy-app exec vitest run sources/components/tools/mcpApps/NativeMcpAppFrameAdapter.native.test.tsx sources/components/tools/McpAppHost.test.tsx sources/components/tools/ToolView.test.tsx
```

Expected: FAIL with missing modules/components.

- [ ] **Step 4: Build a deterministic official AppBridge Host Shell.**

The browser entry imports `@modelcontextprotocol/ext-apps/app-bridge`, accepts only these parent messages, and emits only these host events:

```ts
const mcpAppToolResultSchema = z.object({
    content: z.array(z.unknown()),
    structuredContent: z.unknown().optional(),
    _meta: z.unknown().optional(),
    isError: z.boolean().optional(),
});

const hostCommandSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('mount'), instanceId: z.string(), html: z.string(), context: hostContextSchema }),
    z.object({ type: z.literal('tool-input'), instanceId: z.string(), input: z.record(z.string(), z.unknown()) }),
    z.object({ type: z.literal('tool-result'), instanceId: z.string(), result: mcpAppToolResultSchema }),
    z.object({ type: z.literal('tool-cancelled'), instanceId: z.string(), reason: z.string().max(280) }),
    z.object({ type: z.literal('host-context'), instanceId: z.string(), context: hostContextSchema }),
    z.object({ type: z.literal('teardown'), instanceId: z.string() }),
]);
```

The build script creates a minified IIFE and writes a TypeScript string export deterministically. Add `build:mcp-app-host-shell` to the App package and a Vitest check that regeneration has no diff.

- [ ] **Step 5: Implement the native adapter with restrictive WebView props.**

Load the inline shell with `source={{ html, baseUrl: 'https://mcp-app-host.invalid/' }}` and use `originWhitelist={['https://mcp-app-host.invalid']}`, `javaScriptCanOpenWindowsAutomatically={false}`, `allowFileAccess={false}`, `allowFileAccessFromFileURLs={false}`, `allowUniversalAccessFromFileURLs={false}`, `mediaPlaybackRequiresUserAction`, and `onShouldStartLoadWithRequest` that permits only the initial Host Shell document. All View link requests travel through the bridge; no WebView navigation performs them.

- [ ] **Step 6: Implement `McpAppHost` and retain the tool header.**

```tsx
{tool.mcpApp ? (
    <View style={styles.mcpAppContent} testID="mcp-app-content">
        <McpAppHost
            sessionId={sessionId}
            toolCall={tool}
            presentation={tool.mcpApp}
            result={tool.mcpAppResult}
        />
    </View>
) : null}
```

For MCP tools, set `minimal = !tool.mcpApp` so the old compact fallback remains unchanged but Apps get content below the existing title/status. Loading, offline, retry, unsupported, and error states use semantic tokens and translated strings.

Add stable test IDs at the owned boundaries: `tool-card-header` on the existing header, `mcp-app-content` on the Host container, `mcp-app-error` on the display-safe fallback, and `mcp-app-sandbox-frame` on the platform frame. Do not expose call IDs, server names, resource URIs, or connector context in DOM attributes.

- [ ] **Step 7: Add translations and translation-shape coverage.**

Add the same `mcpApps` key shape to `en`, `zh-Hans`, `zh-Hant`, `ja`, `ca`, `es`, `it`, `pl`, `pt`, and `ru`. The test iterates all translations and asserts non-empty values for loading, offline, retry, unsupported, unavailable, and open-link confirmation strings.

- [ ] **Step 8: Run PR 2 static verification.**

```bash
pnpm --filter happy-app run build:mcp-app-host-shell
pnpm --filter happy-app exec vitest run sources/components/tools/McpAppHost.test.tsx sources/components/tools/mcpApps sources/components/tools/ToolView.test.tsx sources/text/mcpAppTranslations.test.ts sources/sync/typesRaw.spec.ts sources/sync/reducer/reducer.spec.ts sources/utils/otaRuntimeConfig.test.ts
pnpm --filter happy-app typecheck
pnpm --filter @wangjs-jacky/paws exec vitest run --project unit src/codex/mcpApps
git diff --check
```

Expected: PASS. Confirm `packages/happy-app/scripts/ota-runtime-config.js` and `ota-runtime-versions.json` did not change.

- [ ] **Step 9: Commit native presentation.**

```bash
git add packages/happy-app pnpm-lock.yaml
git commit -m "feat(app): render read-only MCP Apps on native"
```

- [ ] **Step 10: Stop at the runtime validation gate.**

Ask the user before starting Expo, Android, or OTA. After explicit confirmation, validate these named cases on the preview runtime 22 build: `MCP-NATIVE-001` successful read-only App, `MCP-NATIVE-002` offline fallback, `MCP-NATIVE-003` invalid resource, `MCP-NATIVE-004` resize and teardown. Because the lockfile changed, let the native-sensitive CI gate decide whether a new preview binary is required; do not force an OTA onto an incompatible runtime. Record screenshots and the exact commit in the PR.

---

## PR 3 — Interactive Resource and Tool Calls

Visible native cases add View `resources/read`, safe direct tool calls, permission approval/denial, and mediated links.

### Task 9: Add bounded secondary resource reads and catalog-authorized tool calls

**Files:**

- Modify: `packages/happy-cli/src/codex/codexAppServerTypes.ts`
- Modify: `packages/happy-cli/src/codex/codexAppServerClient.ts`
- Modify: `packages/happy-cli/src/codex/mcpApps/CodexMcpAppAdapter.ts`
- Modify: `packages/happy-cli/src/codex/mcpApps/registerMcpAppRpcHandlers.ts`
- Modify: `packages/happy-cli/src/codex/mcpApps/registerMcpAppRpcHandlers.test.ts`
- Modify: `packages/happy-cli/src/codex/runCodex.ts`

**Interfaces:**

- Consumes: `mcpAppResourceRead({ callId, uri })` and `mcpAppToolCall({ callId, tool, arguments?, _meta? })`.
- Produces: bounded standard `ReadResourceResult` and structured MCP tool result.
- Invariant: requests contain no thread/server/connector; cross-server, disabled, model-only, oversized, deep, and stale catalog requests fail before execution.

- [ ] **Step 1: Write failing policy tests.**

Cover absent visibility, `visibility: ['app']`, model-only visibility, wrong server, disabled tool, connector mismatch, catalog refresh, argument/result byte/depth bounds, secondary resource URI scheme, and cancellation on disconnect.

```ts
expect(toolCallRequest).toEqual({
    threadId: 'thread-1',
    server: 'demo',
    tool: 'refresh',
    arguments: { id: 1 },
    originCallId: 'call-1',
});
expect(toolCallRequest).not.toHaveProperty('connectorId');
```

- [ ] **Step 2: Run focused tests and confirm the two RPC methods are unregistered.**

Run: `pnpm --filter @wangjs-jacky/paws exec vitest run --project unit src/codex/mcpApps/registerMcpAppRpcHandlers.test.ts`

Expected: FAIL on handler and policy assertions.

- [ ] **Step 3: Add typed Codex methods and tolerant annotations.**

```ts
export type McpToolAnnotations = {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
};

export type McpToolCatalogEntry = {
    name: string;
    enabled?: boolean;
    annotations?: McpToolAnnotations;
    _meta?: { ui?: { visibility?: string[] } };
    [key: string]: unknown;
};
```

Normalize current/deprecated status shapes in the adapter. The allow rule is: visibility absent OR contains `app`; explicit model-only visibility is denied.

- [ ] **Step 4: Implement bounded secondary reads.**

Accept only `ui://` and the schemes declared by the primary resource metadata. Return standard MCP contents inline up to 512 KiB serialized; otherwise return `MCP_APP_RESOURCE_TOO_LARGE`. Never use the primary HTML chunk store for secondary reads.

- [ ] **Step 5: Implement catalog lookup and direct tool calls.**

Refresh through `mcpServerStatus/list`, select only the immutable binding server, then call `mcpServer/tool/call` with derived thread/server and `originCallId`. Strip caller attempts to set connector/account metadata and merge only host-generated provenance.

- [ ] **Step 6: Route risky direct calls through `CodexPermissionHandler`.**

For `readOnlyHint !== true`, `destructiveHint === true`, or `openWorldHint === true`, call:

```ts
const permissionId = `mcp-app-${binding.callId}-${requestSequence}`;
const decision = await permissionHandler.handleToolCall(
    permissionId,
    `mcp__${binding.server}__${request.tool}`,
    request.arguments ?? {},
);
if (decision.decision === 'denied' || decision.decision === 'abort') {
    throw mcpAppError('MCP_APP_PERMISSION_DENIED', false);
}
```

Invoke Codex only after approval. Preserve existing permission mode semantics and never add MCP App tools to the always-auto-approved list.

- [ ] **Step 7: Run focused tests and CLI typecheck.**

```bash
pnpm --filter @wangjs-jacky/paws exec vitest run --project unit src/codex/mcpApps src/codex/__tests__/permissionHandler.test.ts
pnpm --filter @wangjs-jacky/paws typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit interactive CLI authority.**

```bash
git add packages/happy-cli/src/codex
git commit -m "feat(codex): authorize MCP App actions"
```

### Task 10: Bridge interactive requests and mediate external links in App

**Files:**

- Modify: `packages/happy-app/sources/sync/ops.mcpApps.ts`
- Modify: `packages/happy-app/sources/sync/ops.mcpApps.test.ts`
- Modify: `packages/happy-app/sources/components/tools/mcpApps/types.ts`
- Modify: `packages/happy-app/sources/components/tools/mcpApps/hostController.ts`
- Modify: `packages/happy-app/sources/components/tools/mcpApps/hostController.test.ts`
- Modify: `packages/happy-app/mcp-app-sandbox/hostShell.ts`
- Modify: `packages/happy-app/sources/components/tools/mcpApps/NativeMcpAppFrameAdapter.native.test.tsx`
- Create: `packages/happy-app/sources/components/tools/mcpApps/linkPolicy.ts`
- Create: `packages/happy-app/sources/components/tools/mcpApps/linkPolicy.test.ts`
- Modify: translation files under `packages/happy-app/sources/text/translations/`

**Interfaces:**

- Consumes: official bridge requests for `resources/read`, `tools/call`, `ping`, `ui/open-link`, and size changes.
- Produces: correlated JSON-RPC success/error responses and an existing Paws external-link confirmation action.
- Invariant: at most 8 concurrent bridge requests, at most 30 requests/minute/View, and at most 256 KiB serialized per bridge message.

- [ ] **Step 1: Add failing interaction and link-policy tests.**

Test correlation IDs, unsupported methods, concurrency/rate limits, late response disposal, permission denial, `https:`, localhost development HTTP, credentials in URL, and blocked `javascript:`, `data:`, `file:`, custom schemes.

```ts
expect(parseMcpAppExternalUrl('https://user:pass@example.com')).toEqual({
    ok: false,
    code: 'MCP_APP_BRIDGE_PROTOCOL',
});
```

- [ ] **Step 2: Run tests and confirm interaction methods are unsupported.**

```bash
pnpm --filter happy-app exec vitest run sources/components/tools/mcpApps/hostController.test.ts sources/components/tools/mcpApps/linkPolicy.test.ts sources/components/tools/mcpApps/NativeMcpAppFrameAdapter.native.test.tsx
```

Expected: FAIL on request handling and link mediation.

- [ ] **Step 3: Extend the narrow bridge union.**

Add only protocol requests/responses for `resources/read`, `tools/call`, `ping`, `ui/open-link`, and `ui/notifications/size-changed`. Explicitly return JSON-RPC method-not-found for fullscreen, PiP, device permissions, sampling, model context, downloads, prompts, list-changed, and event streams.

- [ ] **Step 4: Implement controller request limits and cancellation.**

Use an instance-scoped token bucket and `AbortController`. When a limit, schema, or size check fails, respond with a stable code; for malformed envelope/source/instance ID, tear down the whole frame with `MCP_APP_BRIDGE_PROTOCOL`.

- [ ] **Step 5: Mediate links through the existing confirmation surface.**

Parse with `new URL`, remove no fields, reject credentials/fragments only when malformed, and allow `https:` in production. Allow `http:` only when hostname is `localhost`, `127.0.0.1`, or `::1` and `__DEV__` is true. Ask for confirmation before `openExternalUrl`.

- [ ] **Step 6: Regenerate Host Shell and run App checks.**

```bash
pnpm --filter happy-app run build:mcp-app-host-shell
pnpm --filter happy-app exec vitest run sources/components/tools/mcpApps sources/sync/ops.mcpApps.test.ts sources/text/mcpAppTranslations.test.ts sources/utils/otaRuntimeConfig.test.ts
pnpm --filter happy-app typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit interactive App bridge.**

```bash
git add packages/happy-app
git commit -m "feat(app): enable MCP App interactions"
```

### Task 11: Add redacted observability, security regression coverage, and finish PR 3

**Files:**

- Create: `packages/happy-cli/src/codex/mcpApps/mcpAppTelemetry.ts`
- Create: `packages/happy-cli/src/codex/mcpApps/mcpAppTelemetry.test.ts`
- Create: `packages/happy-app/sources/components/tools/mcpApps/mcpAppTelemetry.ts`
- Create: `packages/happy-app/sources/components/tools/mcpApps/mcpAppTelemetry.test.ts`
- Modify: relevant host/controller/RPC modules to emit redacted lifecycle events.

**Interfaces:**

- Consumes: lifecycle stage, duration, byte count, platform, origin-scoped boolean, stable outcome code.
- Produces: local structured diagnostics and five product event names from the spec.
- Invariant: a serialization snapshot cannot contain banned sensitive keys or values.

- [ ] **Step 1: Write a redaction snapshot test with canary secrets.**

```ts
const serialized = JSON.stringify(buildMcpAppTelemetry({
    platform: 'android',
    stage: 'resource',
    durationMs: 120,
    byteLength: 4096,
    code: 'MCP_APP_INVALID_RESOURCE',
    sensitiveFixture: 'CANARY_MUST_NOT_APPEAR',
} as never));
expect(serialized).not.toContain('CANARY_MUST_NOT_APPEAR');
expect(serialized).not.toMatch(/uri|connector|arguments|result|_meta|html/i);
```

- [ ] **Step 2: Run telemetry tests and confirm the modules are missing.**

```bash
pnpm --filter @wangjs-jacky/paws exec vitest run --project unit src/codex/mcpApps/mcpAppTelemetry.test.ts
pnpm --filter happy-app exec vitest run sources/components/tools/mcpApps/mcpAppTelemetry.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement allowlist-only telemetry.**

Emit only `platform`, `stage`, `durationBucket`, `byteSizeBucket`, `originScoped`, and `outcomeCode`. Do not accept an arbitrary metadata record in the telemetry function signature.

- [ ] **Step 4: Run the PR 3 security matrix.**

```bash
pnpm --filter @wangjs-jacky/paws exec vitest run --project unit src/codex/mcpApps src/codex/__tests__/permissionHandler.test.ts
pnpm --filter happy-app exec vitest run sources/components/tools/mcpApps sources/components/tools/McpAppHost.test.tsx sources/sync/ops.mcpApps.test.ts sources/utils/otaRuntimeConfig.test.ts
pnpm --filter @wangjs-jacky/paws typecheck
pnpm --filter happy-app typecheck
git diff --check
```

Expected: PASS. Search changed logging calls and confirm none interpolates resource URI, App name, connector/link IDs, arguments, results, `_meta`, or raw errors.

- [ ] **Step 5: Commit observability.**

```bash
git add packages/happy-cli/src/codex/mcpApps packages/happy-app/sources/components/tools/mcpApps
git commit -m "feat(mcp-apps): add redacted lifecycle telemetry"
```

- [ ] **Step 6: Stop at the interactive runtime gate.**

After explicit user confirmation, validate `MCP-NATIVE-005` read-only View tool call, `MCP-NATIVE-006` risky tool approval, `MCP-NATIVE-007` denied tool action, `MCP-NATIVE-008` secondary resource, and `MCP-NATIVE-009` mediated HTTPS link. Confirm teardown after collapse and session termination. Publish preview OTA only if CI/runtime compatibility says the dependency/lockfile set is compatible; otherwise build/install the required preview binary first.

---

## PR 4 — Different-origin Web Sandbox Proxy

Visible Web cases: successful App, lifecycle fallback, blocked cross-origin access, forged-message rejection, and mediated interaction on real HTTPS origins.

### Task 12: Serve the Sandbox Proxy only from the configured sandbox origin

**Files:**

- Create: `packages/happy-server/sources/app/api/mcpAppSandboxSecurity.ts`
- Create: `packages/happy-server/sources/app/api/mcpAppSandboxSecurity.spec.ts`
- Create: `packages/happy-server/sources/app/api/routes/mcpAppSandboxRoutes.ts`
- Create: `packages/happy-server/sources/app/api/routes/mcpAppSandboxRoutes.spec.ts`
- Create: `packages/happy-server/sources/app/api/generated/mcpAppHostShellAssets.ts`
- Modify: `packages/happy-server/sources/app/api/api.ts`
- Modify: `packages/happy-app/scripts/build-mcp-app-host-shell.cjs`

**Interfaces:**

- Consumes: `HAPPY_MCP_APP_SANDBOX_ORIGIN`, comma-separated `HAPPY_MCP_APP_PARENT_ORIGINS`, validated MCP UI CSP metadata, and the generated official Host Shell bundle.
- Produces: `GET /mcp-app-sandbox/host` and `GET /mcp-app-sandbox/host.js` from the sandbox hostname only, with dynamic allowlisted parent origin and header-enforced CSP.
- Invariant: no wildcard target origin; request host and requested parent origin must both match configuration.

- [ ] **Step 1: Write failing pure security helper tests.**

Cover exact HTTPS origins, default ports, trailing paths, wildcard rejection, lookalike subdomains, non-sandbox Host header, localhost development mode, empty production allowlists, CSP metadata beyond 8 KiB, more than 32 domains in one category, credentials/paths in origins, and non-HTTPS domains.

```ts
expect(resolveSandboxRequest({
    requestHost: 'sandbox.paws.example',
    parentOrigin: 'https://paws.example.evil.test',
    sandboxOrigin: 'https://sandbox.paws.example',
    allowedParentOrigins: ['https://paws.example'],
    development: false,
})).toEqual({ ok: false });
```

- [ ] **Step 2: Run tests and confirm the security modules are absent.**

```bash
pnpm --filter happy-server-self-host exec vitest run sources/app/api/mcpAppSandboxSecurity.spec.ts sources/app/api/routes/mcpAppSandboxRoutes.spec.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Generate the server document from the same Host Shell source.**

Extend `build-mcp-app-host-shell.cjs` to emit the native string bundle plus a server TypeScript asset export containing static HTML and external JavaScript. The HTML loads only `/mcp-app-sandbox/host.js`; it contains no inline configuration script. The external script reads the already server-validated `parentOrigin` from `location.search`, validates it again as an exact origin, and uses it for every Host↔Proxy `postMessage` target.

- [ ] **Step 4: Implement the route and exact headers.**

The Host URL also carries a base64url-encoded canonical JSON `csp` parameter with only `connectDomains`, `resourceDomains`, and `frameDomains`. Parse with Zod, cap the encoded value at 8 KiB and each array at 32 entries, normalize each entry to an HTTPS origin with no credentials/path/query/fragment, and permit localhost HTTP only in development. Build the response header from those exact origin arrays; do not accept wildcard entries.

The HTML response must include:

```ts
{
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': [
        "default-src 'none'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'unsafe-inline'",
        `img-src data: blob: ${resourceOrigins.join(' ')}`,
        `media-src blob: ${resourceOrigins.join(' ')}`,
        `font-src data: ${resourceOrigins.join(' ')}`,
        `connect-src ${connectOrigins.join(' ') || "'none'"}`,
        `frame-src 'self' ${frameOrigins.join(' ')}`,
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        `frame-ancestors ${parentOrigin}`,
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), clipboard-write=()',
}
```

Also set `Cross-Origin-Resource-Policy: cross-origin` and do not set permissive CORS. The JavaScript response uses `Content-Type: text/javascript; charset=utf-8`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and the same sandbox-host restriction. Register both routes before static SPA fallback. Reject invalid host/origin/CSP input with a no-store 404 that reveals no allowlist values. The inherited CSP deliberately permits inline View scripts inside the opaque-origin inner sandbox but does not grant same-origin access or undeclared network domains.

- [ ] **Step 5: Test Fastify injection behavior.**

Assert accepted sandbox host/parent, wrong host, unexpected parent, missing config, exact declared-domain CSP output, undeclared-domain absence, wildcard rejection, HTML external-script reference, JavaScript content type, referrer/no-store/nosniff, and escaped query parsing.

- [ ] **Step 6: Run server checks.**

```bash
pnpm --filter happy-app run build:mcp-app-host-shell
pnpm --filter happy-server-self-host exec vitest run sources/app/api/mcpAppSandboxSecurity.spec.ts sources/app/api/routes/mcpAppSandboxRoutes.spec.ts
pnpm --filter happy-server-self-host typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit the sandbox endpoint.**

```bash
git add packages/happy-server packages/happy-app/scripts/build-mcp-app-host-shell.cjs
git commit -m "feat(server): serve isolated MCP App sandbox"
```

### Task 13: Implement the exact-origin Web frame adapter and feature gate

**Files:**

- Create: `packages/happy-app/sources/components/tools/mcpApps/WebMcpAppFrameAdapter.web.ts`
- Create: `packages/happy-app/sources/components/tools/mcpApps/WebMcpAppFrameAdapter.web.test.tsx`
- Create: `packages/happy-app/sources/components/tools/mcpApps/frameAdapter.ts`
- Create: `packages/happy-app/sources/components/tools/mcpApps/frameAdapter.test.ts`
- Modify: `packages/happy-app/sources/components/tools/McpAppHost.tsx`
- Modify: `packages/happy-app/sources/components/tools/McpAppHost.test.tsx`
- Modify: `packages/happy-app/sources/components/tools/mcpApps/mcpAppTelemetry.ts`

**Interfaces:**

- Consumes: `EXPO_PUBLIC_MCP_APP_SANDBOX_ORIGIN`, current Paws Web origin, Sandbox Proxy `ready`, and the common frame contract.
- Produces: one outer different-origin iframe with exact-origin/source/referrer checks and one inner sandboxed View owned by the Proxy.
- Invariant: production never uses `srcdoc` or same-origin fallback; Host↔Proxy `postMessage` never uses `*`.

- [ ] **Step 1: Write failing configuration and browser-event tests.**

Cover missing origin, same origin, non-HTTPS production origin, localhost development, expected `event.source`, exact `event.origin`, stale instance ID, wrong referrer acknowledgment, oversize message, teardown, and feature-disabled fallback.

```ts
expect(resolveWebMcpAppSandbox({
    appOrigin: 'https://paws.example',
    sandboxOrigin: 'https://paws.example',
    development: false,
})).toEqual({ enabled: false, code: 'MCP_APP_SANDBOX_UNAVAILABLE' });
```

- [ ] **Step 2: Run focused tests and confirm the Web adapter is absent.**

```bash
pnpm --filter happy-app exec vitest run sources/components/tools/mcpApps/WebMcpAppFrameAdapter.web.test.tsx sources/components/tools/mcpApps/frameAdapter.test.ts sources/components/tools/McpAppHost.test.tsx
```

Expected: FAIL with missing module/feature gate.

- [ ] **Step 3: Implement platform adapter selection.**

```ts
export function createMcpAppFrameAdapter(): McpAppFrameAdapter {
    if (Platform.OS === 'web') return createWebMcpAppFrameAdapter();
    if (Platform.OS === 'android' || Platform.OS === 'ios') return createNativeMcpAppFrameAdapter();
    return createUnsupportedMcpAppFrameAdapter();
}
```

The Web factory returns unsupported when configuration is absent/unsafe; it does not silently select a same-origin implementation.

- [ ] **Step 4: Implement exact-origin Proxy messaging.**

Build the iframe URL with `new URL('/mcp-app-sandbox/host', sandboxOrigin)`, an exact `parentOrigin` query, and canonical base64url `csp` derived from the verified resource metadata returned by `mcpAppResourceOpen`. Store the iframe's `contentWindow`, accept messages only from that object and exact sandbox origin, and send only to exact sandbox origin. Remove the iframe and listener on any protocol violation or teardown.

- [ ] **Step 5: Run App checks and runtime contract.**

```bash
pnpm --filter happy-app exec vitest run sources/components/tools/mcpApps sources/components/tools/McpAppHost.test.tsx sources/utils/otaRuntimeConfig.test.ts
pnpm --filter happy-app typecheck
```

Expected: PASS. Web without configuration renders the ordinary MCP tool card plus translated unsupported fallback.

- [ ] **Step 6: Commit Web adapter.**

```bash
git add packages/happy-app/sources/components/tools
git commit -m "feat(app): add isolated Web MCP App host"
```

### Task 14: Add real-origin Playwright security/evidence coverage and release gates

**Files:**

- Create: `packages/happy-app/e2e/mcp-app-host-evidence.spec.ts`
- Create: `packages/happy-app/e2e/helpers/mcpAppHarness.ts`
- Create: `scripts/configure-production-mcp-app-sandbox-caddy.mjs`
- Create: `scripts/configure-production-mcp-app-sandbox-caddy.test.mjs`
- Create: `scripts/verify-production-mcp-app-sandbox.mjs`
- Create: `scripts/verify-production-mcp-app-sandbox.test.mjs`
- Modify: `.github/workflows/web-production-deploy.yml`

**Interfaces:**

- Consumes: deployed Paws Web origin, separately deployed sandbox origin, deterministic fixture MCP App, and authenticated Web test session.
- Produces: verified isolation/security assertions and visual evidence for the PR.
- Invariant: this task does not claim Web support ready until the real deployed origins pass; static same-origin tests are insufficient.

- [ ] **Step 1: Add the Playwright scenario before deployment.**

The test uses a live session prepared with the reviewed official ext-apps example server. Require `HAPPY_MCP_APP_E2E_SESSION_ID` and `HAPPY_MCP_APP_SANDBOX_ORIGIN` at module load, and fail immediately when either is absent. Implement these five named cases with concrete assertions:

```ts
test.beforeEach(async ({ page }) => {
    await page.goto(sessionUrl(process.env.HAPPY_MCP_APP_E2E_SESSION_ID!));
    await expect(page.getByTestId('mcp-app-content')).toBeVisible();
});

test('[MCP-WEB-001] renders a read-only App on the sandbox origin', async ({ page }) => {
    const { proxy, view } = await findMcpAppFrames(page, sandboxOrigin);
    expect(new URL(proxy.url()).origin).toBe(sandboxOrigin);
    expect(new URL(proxy.url()).origin).not.toBe(new URL(page.url()).origin);
    await expect.poll(() => view.locator('[data-testid="mcp-example-root"]').count()).toBe(1);
});

test('[MCP-WEB-002] blocks parent DOM and cookie access', async ({ page }) => {
    const { view } = await findMcpAppFrames(page, sandboxOrigin);
    const access = await view.evaluate(() => {
        try {
            void window.top!.document.cookie;
            return 'accessible';
        } catch (error) {
            return error instanceof DOMException ? error.name : 'unexpected-error';
        }
    });
    expect(access).toBe('SecurityError');
});

test('[MCP-WEB-003] rejects a forged Proxy message', async ({ page }) => {
    await injectUnexpectedSourceMessage(page, sandboxOrigin);
    await expect(page.getByTestId('mcp-app-content')).toBeVisible();
    await expect(page.getByTestId('mcp-app-error')).toHaveCount(0);
});

test('[MCP-WEB-004] mediates an App tool call and teardown', async ({ page }) => {
    const { view } = await findMcpAppFrames(page, sandboxOrigin);
    await view.locator('[data-testid="mcp-example-tool-call"]').click();
    await expect(view.locator('[data-testid="mcp-example-tool-result"]')).toHaveText('approved');
    await page.goto(new URL('/', process.env.HAPPY_E2E_WEB_URL!).toString());
    await expect(page.locator('[data-testid="mcp-app-sandbox-frame"]')).toHaveCount(0);
});

test('[MCP-WEB-005] keeps the tool card when the sandbox is unavailable', async ({ page }) => {
    await page.route('**/mcp-app-sandbox/host*', (route) => route.abort('failed'));
    await page.reload();
    await expect(page.getByTestId('tool-card-header')).toBeVisible();
    await expect(page.getByTestId('mcp-app-error')).toBeVisible();
    await expect(page.getByTestId('mcp-app-sandbox-frame')).toHaveCount(0);
});
```

`findMcpAppFrames` polls `page.frames()` for the outer exact sandbox origin and its child View frame. `injectUnexpectedSourceMessage` creates a temporary same-origin attacker iframe whose script posts a syntactically valid message to the Proxy; the Proxy must ignore it because `event.source` is not the Paws parent window. Remove the attacker iframe after posting.

- [ ] **Step 2: Add a guarded production routing and enablement path.**

`configure-production-mcp-app-sandbox-caddy.mjs` must require an already provisioned different-origin HTTPS Caddy site block; it never creates certificates or broadens the Paws Web `:8443` block. Within that existing sandbox site, install one managed block that reverse-proxies only `/mcp-app-sandbox/host` and `/mcp-app-sandbox/host.js` to `localhost:3005` and returns 404 for every other path. Its Node tests prove idempotence, unrelated-site preservation, exact path restriction, missing-site failure, and no output-file mutation when validation fails. The workflow retains the existing guarded Caddy backup/reload rollback pattern.

`verify-production-mcp-app-sandbox.mjs` accepts the sandbox origin and Paws parent origin, performs accepted and rejected-parent requests, and fails unless origin separation, 200/404 behavior, no-store, CSP, Permissions-Policy, nosniff, referrer policy, JavaScript content type, and absence of permissive CORS all match the contract.

Update `web-production-deploy.yml` to read the public repository variable `PAWS_MCP_APP_SANDBOX_ORIGIN`. When it is empty, export Web without `EXPO_PUBLIC_MCP_APP_SANDBOX_ORIGIN` and report MCP Apps disabled. When non-empty, validate that it differs from `PAWS_WEB_ORIGIN`, configure the already provisioned Caddy site, run the verification script, and only then pass it as `EXPO_PUBLIC_MCP_APP_SANDBOX_ORIGIN` to `expo export`. Any route/header verification failure must abort before the OSS Web entry switches.

- [ ] **Step 3: Run all static/unit gates before requesting deployment.**

```bash
pnpm --filter @slopus/happy-wire test
pnpm --filter @wangjs-jacky/paws exec vitest run --project unit src/codex/mcpApps src/codex/codexAppServerClient.test.ts src/codex/__tests__/sessionProtocolMapper.test.ts
pnpm --filter @wangjs-jacky/paws typecheck
pnpm --filter happy-app exec vitest run sources/components/tools/mcpApps sources/components/tools/McpAppHost.test.tsx sources/sync/ops.mcpApps.test.ts sources/sync/typesRaw.spec.ts sources/sync/reducer/reducer.spec.ts sources/text/mcpAppTranslations.test.ts sources/utils/otaRuntimeConfig.test.ts
pnpm --filter happy-app typecheck
pnpm --filter happy-server-self-host exec vitest run sources/app/api/mcpAppSandboxSecurity.spec.ts sources/app/api/routes/mcpAppSandboxRoutes.spec.ts
pnpm --filter happy-server-self-host typecheck
node --test scripts/configure-production-mcp-app-sandbox-caddy.test.mjs scripts/verify-production-mcp-app-sandbox.test.mjs
git diff --check
```

Expected: PASS.

- [ ] **Step 4: Commit the complete feature-disabled PR source.**

```bash
git add packages/happy-app/e2e packages/happy-server packages/happy-app/scripts/build-mcp-app-host-shell.cjs scripts/configure-production-mcp-app-sandbox-caddy.mjs scripts/configure-production-mcp-app-sandbox-caddy.test.mjs scripts/verify-production-mcp-app-sandbox.mjs scripts/verify-production-mcp-app-sandbox.test.mjs .github/workflows/web-production-deploy.yml
git commit -m "test(mcp-apps): gate Web sandbox rollout"
```

Open PR 4 with Web MCP Apps disabled by default. Static review can complete without provisioning infrastructure; enabling the public feature is a post-merge production gate because this repository permits Web publication only from merged `main` CI/CD.

- [ ] **Step 5: Stop and request explicit deployment/browser approval.**

State the exact intended public sandbox origin, Paws parent origins, server environment variables, backend rollout method for the new Happy Server route, TLS/Caddy site provisioning change, repository variable change, merge-to-main workflow, and Playwright command. Recommend a dedicated hostname; a different trusted HTTPS port on `47.115.228.20` is acceptable only when its certificate, firewall, and origin behavior are verified. Paws Web remains `https://47.115.228.20:8443` and may only publish through merge-to-main CI/CD.

- [ ] **Step 6: After approval, merge/deploy with the feature flag absent and verify the endpoint.**

Merge PR 4, deploy the merged Happy Server route through the approved backend path, provision the separate Caddy HTTPS site, and leave `PAWS_MCP_APP_SANDBOX_ORIGIN` unset for the first Web workflow run. Run the verification script against the approved sandbox hostname and assert status 200, different origin, `Cache-Control: no-store`, exact declared-domain CSP, no permissive CORS, and a mismatched parent origin returning 404. Do not print cookies or auth headers. If any check fails, keep the repository variable absent and Web remains disabled.

- [ ] **Step 7: Enable through the guarded workflow, then run Playwright on real origins.**

```bash
HAPPY_E2E_WEB_URL='https://47.115.228.20:8443' \
HAPPY_E2E_RECORD=1 \
HAPPY_MCP_APP_EVIDENCE_DIR="$PWD/artifacts/mcp-apps-web" \
pnpm --filter happy-app exec playwright test e2e/mcp-app-host-evidence.spec.ts
```

Set the approved `PAWS_MCP_APP_SANDBOX_ORIGIN` repository variable and rerun `web-production-deploy.yml`. Run the command in the validation environment where `HAPPY_MCP_APP_SANDBOX_ORIGIN` and `HAPPY_MCP_APP_E2E_SESSION_ID` were set by the approved Step 5 setup; the test's module-load checks prevent accidental execution without them.

Expected: all five named cases PASS. The evidence directory contains successful App, fallback, isolation, and interaction screenshots plus trace/video according to the existing Playwright config.

- [ ] **Step 8: Complete final review and post-merge handoff.**

Review the diff against every goal/non-goal and deferred capability in the approved spec. Confirm no unfinished markers, commented bypass, same-origin fallback, wildcard `postMessage`, unscoped trusted retry, direct App-to-MCP connection, raw HTML persistence, or sensitive logging remains. The PR body must include:

```text
Visible UI cases: 5
Tested: MCP-WEB-001, MCP-WEB-002, MCP-WEB-003, MCP-WEB-004, MCP-WEB-005
Sandbox origin: value verified by the endpoint check in Step 6
Paws Web origin: https://47.115.228.20:8443
Static gates: happy-wire, happy-cli, happy-app, happy-server
Runtime contract: unchanged (preview 22, production 23)
Deferred: fullscreen/PiP, device permissions, sampling, model-context mutation,
downloads, prompts, list-changed, event streams, offline HTML cache, non-Codex providers
```

## End-to-End Acceptance Checklist

- [ ] Old Paws clients ignore the additive fields and old events still parse.
- [ ] Extended initialize advertises only `text/html;profile=mcp-app`; invalid params cause exactly one reconnect and legacy initialize.
- [ ] Live and historical MCP calls produce the same presentation/result ordering and stable call IDs.
- [ ] Structured content and `_meta` reach only the encrypted View path and are never stringified or logged.
- [ ] Trusted primary reads always use `originCallId = callId` after successful completion and never retry unscoped.
- [ ] Ordinary MCP server primary reads remain thread-scoped.
- [ ] Resource HTML is MIME/URI/size checked, chunked, offset/length/SHA-256 verified, memory-bounded, and expired.
- [ ] View requests cannot choose thread, server, connector, or account.
- [ ] Catalog visibility/current enablement is checked before a View tool call.
- [ ] Risky tool calls use the existing Paws permission surface and denied actions do not execute.
- [ ] Native uses one Host Shell WebView plus an inner sandboxed iframe and no generic native bridge.
- [ ] Web uses a real different HTTPS origin, exact source/origin/referrer validation, header CSP, no-store, and no wildcard `postMessage`.
- [ ] Host lifecycle ordering, buffering, cancellation, timeouts, resize clamping/throttling, and teardown pass in-memory tests.
- [ ] Unsupported/offline/resource/sandbox failures retain the ordinary tool card and a translated static fallback.
- [ ] Telemetry contains only allowlisted fields and stable error codes.
- [ ] App dependencies add no native module/Expo plugin and runtime mappings remain unchanged.
- [ ] User-approved runtime evidence and deployment gates are completed before claiming native/Web production readiness.
