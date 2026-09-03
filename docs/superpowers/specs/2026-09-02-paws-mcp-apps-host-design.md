# Paws MCP Apps Host Technical Design

**Status:** Approved

**Date:** 2026-09-02

**Paws baseline:** `origin/main` at `314c00a3947142a00273449a006887fc61da65b9`

**Codex reference:** `openai/codex` at `eb10d91e48ccbd0930427461fb392337addb1ac0`

**MCP Apps specification:** Stable `2026-01-26`

## Summary

Paws will support MCP Apps by keeping Codex app-server as the owner of MCP
connections, authentication, account selection, tool policy, and resource
provenance, while adding a remote MCP App Host to the Paws conversation UI.

The selected architecture is:

```text
MCP Server
    ↕ MCP
Codex app-server
    ↕ app-server JSON-RPC
Paws CLI
    ↕ encrypted session messages + encrypted session RPC
Paws McpAppHost
    ↕ MCP Apps postMessage protocol
Sandbox Proxy
    ↕
Untrusted MCP App View
```

Paws App does not connect directly to an MCP server. It does not receive MCP
credentials, connector account identifiers, or unrestricted server names from
the View. Every View operation is bound to the Codex thread and originating
tool call by Paws CLI.

The first production milestone supports inline HTML Apps using
`text/html;profile=mcp-app`, initial tool input/result delivery,
`resources/read`, `tools/call`, size changes, teardown, and host-mediated links.
Fullscreen/PiP, camera, microphone, geolocation, clipboard access, sampling,
model-context mutation, downloads, and event streams are deferred.

## Decision

Build one deep `McpAppHost` module with a small rendering interface and two
platform adapters:

- `WebMcpAppFrameAdapter`: official `AppBridge` plus a separately originated
  Sandbox Proxy and an inner iframe.
- `NativeMcpAppFrameAdapter`: a React Native WebView Host Shell containing the
  official bridge behavior and an inner sandboxed iframe.

The module owns resource loading, lifecycle ordering, bridge validation,
timeouts, policy enforcement, error normalization, sizing, and teardown. The
conversation renderer only decides whether a tool call has an MCP App
presentation and mounts the module.

This seam is intentionally placed above platform framing and below the generic
tool card. If the module were deleted, lifecycle, security, RPC, and rendering
logic would otherwise reappear in ToolView, Web-specific iframe code, native
WebView code, and session operations. That is the complexity the module is
expected to hide.

## Goals

- Render standards-compliant MCP Apps inside Paws conversations.
- Reuse Codex app-server's MCP transport, auth, connector selection, and
  resource-origin checks.
- Preserve the full MCP tool result needed by a View: `content`,
  `structuredContent`, and `_meta`.
- Produce the same MCP App descriptor during live streaming and historical
  thread replay.
- Keep MCP App traffic end-to-end encrypted across the Paws relay.
- Isolate untrusted HTML from the Paws document, cookies, React Native bridge,
  filesystem, and arbitrary navigation.
- Provide a text/tool-card fallback when the feature, session, resource, or
  sandbox is unavailable.
- Remain compatible with older Paws clients and older Codex app-server
  versions through additive wire fields and capability fallback.
- Make the security and lifecycle behavior testable through the
  `McpAppHost` interface.

## Non-goals

- Implementing a second general-purpose MCP client in Paws App.
- Connecting the mobile or Web client directly to MCP server transports.
- Replacing Codex app-server's authentication or connector-account model.
- Rendering arbitrary HTML found in Markdown, tool text, or
  `structuredContent`.
- Supporting non-Codex providers in the first release. The wire shape remains
  provider-neutral enough for a later adapter.
- Persisting raw App HTML in ordinary conversation messages.
- Making archived conversations fully interactive while the owning CLI is
  offline.
- Granting browser device permissions in v1.
- Completing the broader Session Protocol v2 migration as part of this work.

## Standards and Reference Baseline

The design follows:

- [MCP Apps stable specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)
- [MCP Apps Host API](https://apps.extensions.modelcontextprotocol.io/api/)
- [Official ext-apps basic Host](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/basic-host)
- [Codex app-server initialization and MCP methods](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/app-server/README.md)
- [Codex MCP app-server protocol types](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/app-server-protocol/src/protocol/v2/mcp.rs)
- [Codex MCP resource-origin enforcement](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/codex-mcp/src/resource_origin.rs)

Required standard behavior:

- Negotiate extension `io.modelcontextprotocol/ui` explicitly.
- Discover a View from `_meta.ui.resourceUri`, with compatibility for the
  deprecated `_meta["ui/resourceUri"]` form handled by Codex.
- Fetch a `ui://` resource through `resources/read`.
- Accept only `text/html;profile=mcp-app` for the v1 renderer.
- Place the View behind a Sandbox Proxy, with the Host and proxy on different
  origins for Web.
- Use JSON-RPC over `postMessage` for View/Host communication.
- Complete `ui/initialize` before sending tool input or result.
- Enforce declared CSP domains and never loosen them.
- Keep app-only tools out of the model tool list and reject View calls to tools
  that are not app-visible.

The URL `https://apps.extensions.modelcontextprotocol.io/api/` is Host SDK
documentation. It is not an MCP server endpoint that Paws can attach directly.

## Existing Paws State

### Codex app-server client

`packages/happy-cli/src/codex/codexAppServerTypes.ts` contains hand-selected
types generated from Codex 0.107.0. Its `InitializeParams` does not include
`capabilities.extensions`, and `ThreadItem.mcpToolCall` does not retain the
current `appContext` contract.

`CodexAppServerClient.initializeConnection()` currently advertises only:

```ts
capabilities: {
    experimentalApi: true,
}
```

Live `item/started` and `item/completed` notifications for `mcpToolCall` have
no dedicated branch. The generic `method.startsWith("item/")` return path
therefore consumes them without producing Paws tool events.

Historical replay recognizes `mcpToolCall`, but converts `item.result` through
`String(item.result)`. This discards `content`, `structuredContent`, `_meta`,
and resource linkage.

### Session transport

Paws already has the required remote transport:

- CLI `ApiSessionClient` sends encrypted session-protocol messages.
- App `apiSocket.sessionRPC()` sends per-session encrypted RPC calls.
- CLI `RpcHandlerManager` registers session-owned handlers and re-registers
  them after reconnect.
- The relay routes opaque ciphertext and does not need MCP-specific knowledge.

The file `packages/happy-wire/src/sessionProtocol.ts` says the session protocol
is frozen and unused, while current Codex, ACP, Ask, and OpenClaw paths actively
call `sendSessionProtocolMessage()`. This comment and the duplicated event
schemas in `happy-app/sources/sync/typesRaw.ts` must be reconciled before adding
the MCP fields. The design does not depend on Session Protocol v2.

### Conversation UI

MCP tools are currently formatted as compact `mcp__...` cards in `ToolView`.
Setting `minimal = true` suppresses the content area, so no App presentation is
possible.

The App already depends on `react-native-webview`, which is sufficient for the
native Host Shell. No new native module is required for the first Android/iOS
implementation.

The Host implementation adds the JavaScript packages
`@modelcontextprotocol/ext-apps` and its compatible MCP SDK peer dependency.
They must be pinned through the repository lockfile. The dependency set must be
audited to confirm it adds no Expo config plugin or native code before treating
the change as OTA-compatible; the Android runtime mapping is not changed by
this design.

## Codex Capabilities Reused by Paws

Current Codex app-server exposes all control-plane operations needed by Paws:

1. `initialize.params.capabilities.extensions` forwards trusted MCP extension
   declarations to downstream MCP initialization.
2. `ThreadItem.mcpToolCall` carries `appContext`, result content,
   `structuredContent`, and `_meta`.
3. `mcpServer/resource/read` performs thread-scoped resource reads.
4. `mcpServer/resource/read` with `originCallId` enforces the originating
   Codex App, connector, link/account, URI, and app policy.
5. `mcpServer/tool/call` invokes a tool through the thread's configured MCP
   runtime.
6. The Codex tool catalog filters explicit app-only tools out of the model's
   tool declarations.

Paws must not bypass item 4. For a trusted Codex App, failure of an
`originCallId`-scoped primary resource read is final. Paws must not retry the
same read as an unscoped request.

## Protocol Compatibility Policy

Paws does not hardcode feature support from a Codex version string alone.

Connection behavior:

1. Attempt `initialize` with the MCP UI extension.
2. If the app-server rejects the added capability as invalid parameters, close
   that transport and reconnect once with the legacy capability shape.
3. Never issue a second `initialize` on the same connection; Codex rejects it.
4. Mark the connection `mcpAppsAdvertised` only after the extended initialize
   succeeds.
5. Render an App only when a tool item also contains a valid `ui://` resource
   URI. Capability advertisement alone is not proof that a particular thread
   has the extension profile.

Codex fixes the MCP extension profile when a thread is started, resumed, or
forked. A later client connection cannot change a thread already loaded by
another app-server connection merely by starting a new turn. Shared app-server
mode must therefore fall back to a normal tool card if the loaded thread did
not negotiate MCP UI support.

### Generated-type drift

The supported local Codex 0.144.5 generated `McpToolCallAppContext` includes
`templateId`; the pinned upstream `main` reference contains `readOnlyHint` on
the item but not `templateId`. Paws must treat additive app-context fields as
optional and preserve unknown fields internally without making them part of
the Paws wire interface.

Implementation rule:

- Generate a complete app-server fixture for each tested Codex version.
- Keep Paws-owned narrow compatibility types around the fields it consumes.
- Add a schema compatibility test that parses the generated fixtures.
- Do not copy the whole generated Codex protocol into Paws.

## Architecture

### Modules and seams

```text
CodexAppServerClient
    │ ThreadItem + direct requests
    ▼
CodexMcpAppAdapter
    │ normalized binding/result
    ▼
McpAppBindingRegistry ──────── session RPC handlers
    │                                  ▲
    │ encrypted descriptor/result      │ encrypted commands
    ▼                                  │
happy-wire                         McpAppRemotePort
    │                                  ▲
    ▼                                  │
conversation reducer ────────> McpAppHost
                                  │
                     ┌────────────┴────────────┐
                     ▼                         ▼
             Web frame adapter         Native frame adapter
```

### `CodexMcpAppAdapter`

Responsibilities:

- Advertise the extension during app-server initialization.
- Parse current and compatible historical `mcpToolCall` items.
- Normalize modern `appContext.resourceUri`, deprecated
  `mcpAppResourceUri`, and the absence of UI metadata.
- Preserve the complete initial tool result.
- Produce identical live and replay event sequences.
- Populate the session-local `McpAppBindingRegistry`.
- Map Codex errors into stable Paws error codes without leaking protocol data.

It is an adapter at the Codex provider seam. Generic conversation code does
not import Codex app-server types.

### `McpAppBindingRegistry`

The registry is session-local and owned by Paws CLI. It is the authority that
binds App operations to a call; the App and View cannot create bindings.

```ts
type McpAppBinding = {
    callId: string;
    threadId: string;
    server: string;
    resourceUri: string;
    input: Record<string, unknown>;
    result?: McpCallToolResult;
    trustedOriginCallId?: string;
    connectorId?: string;
    appName?: string;
    actionName?: string;
};
```

`connectorId` remains inside the CLI. `linkId` is not sent to Paws App and is
not required by the registry's public operations; Codex resolves it from
`originCallId` provenance.

Registry invariants:

- Bindings are created only from app-server thread items.
- `callId`, `threadId`, and `server` are immutable.
- The primary `resourceUri` must start with `ui://`.
- A completed trusted Codex App call uses `trustedOriginCallId = callId`.
- A View request never selects another thread or server.
- Registry entries are rebuilt from `thread/read` during resume/replay.
- Entries are removed when the Paws session terminates.
- In-memory resource buffers have bounded size and lifetime.

### `McpAppHost`

The external React interface is intentionally small:

```ts
type McpAppHostProps = {
    sessionId: string;
    toolCall: ToolCall;
    presentation: McpAppPresentationV1;
    result?: McpAppResultV1;
};

function McpAppHost(props: McpAppHostProps): React.ReactNode;
```

Internally it receives two injected ports:

```ts
interface McpAppRemotePort {
    readResource(input: ReadMcpAppResourceInput): Promise<McpAppResource>;
    callTool(input: CallMcpAppToolInput): Promise<McpAppToolResult>;
}

interface McpAppFrameAdapter {
    mount(input: FrameMountInput): Promise<McpAppFrame>;
}

interface McpAppFrame {
    sendToolInput(input: Record<string, unknown>): void;
    sendToolResult(result: McpAppToolResult): void;
    sendToolCancelled(reason: string): void;
    updateHostContext(context: McpAppHostContext): void;
    teardown(): Promise<void>;
}
```

The production remote port uses encrypted session RPC. Tests use an in-memory
adapter. Web and native satisfy the frame seam, making it a real seam rather
than speculative indirection.

## Wire Contract

MCP App data is attached additively to the existing generic tool lifecycle.
This is safer for mixed Paws versions than introducing a new required event
type: older clients parse the ordinary tool event and ignore unknown optional
fields.

### Tool start extension

```ts
type McpAppPresentationV1 = {
    version: 1;
    server: string;
    resourceUri: string;
    appName?: string;
    actionName?: string;
};

type SessionToolCallStartEvent = {
    t: "tool-call-start";
    call: string;
    name: string;
    title: string;
    description: string;
    args: Record<string, unknown>;
    mcpApp?: McpAppPresentationV1;
};
```

The shared schema applies conservative length limits to `server`,
`resourceUri`, `appName`, and `actionName`. Display names are rendered as plain
text only; they never become HTML, a URL, or an analytics dimension.

The wire descriptor deliberately excludes:

- `threadId`: derived from the Paws session in CLI.
- `originCallId`: always the tool event's `call` for the primary trusted read.
- `connectorId` and `linkId`: authorization context owned by Codex/CLI.
- raw tool metadata: unnecessary and potentially sensitive.
- HTML: fetched lazily over RPC.

### Tool completion extension

```ts
type McpAppResultV1 = {
    version: 1;
} & (
    | {
        state: "available";
        content: unknown[];
        structuredContent?: unknown;
        _meta?: unknown;
    }
    | {
        state: "unavailable";
        code: "MCP_APP_RESULT_TOO_LARGE";
    }
);

type SessionToolCallEndEvent = {
    t: "tool-call-end";
    call: string;
    status?: "completed" | "failed" | "cancelled";
    error?: SessionToolCallError;
    mcpAppResult?: McpAppResultV1;
};
```

`_meta` remains encrypted and is delivered only to the View. It is not rendered
by React, added to model context, included in analytics, or written to normal
logs.

If the serialized result exceeds the configured safe message budget, CLI emits
the `unavailable` result state, retains the ordinary text fallback where
available, and does not mark the underlying successful tool call as failed. It
must not truncate JSON into an invalid result.

### Schema ownership

The canonical Zod schemas live in `happy-wire`. CLI and App import the shared
definitions. `happy-app/sources/sync/typesRaw.ts` may keep preprocessing for
legacy outer wrappers, but must not redefine the touched event shapes.

The stale "unused/frozen" comment in `sessionProtocol.ts` is replaced with an
accurate compatibility policy:

- current v1 is active;
- additions must be optional;
- event IDs remain stable across replay;
- required breaking changes belong in Session Protocol v2.

## Encrypted Session RPC Contract

The App sends only a Paws session ID at the transport level and a tool `callId`
inside encrypted parameters. CLI derives all authority from the binding
registry.

### Resource transfer

Raw single-file Apps may exceed Socket.IO's default message budget after JSON,
encryption, and base64 expansion. Resource transfer is therefore chunked; the
server remains an opaque relay.

```ts
type McpAppResourceOpenRequest = {
    callId: string;
};

type McpAppResourceOpenResponse = {
    resourceId: string;
    uri: string;
    mimeType: "text/html;profile=mcp-app";
    byteLength: number;
    sha256: string;
    encoding: "utf8";
    ui?: {
        csp?: McpUiResourceCsp;
        permissions?: McpUiResourcePermissions;
        prefersBorder?: boolean;
    };
};

type McpAppResourceChunkRequest = {
    resourceId: string;
    offset: number;
};

type McpAppResourceChunkResponse = {
    offset: number;
    dataBase64: string;
    nextOffset?: number;
};
```

RPC method names:

- `mcpAppResourceOpen`
- `mcpAppResourceChunk`
- `mcpAppResourceRead`
- `mcpAppToolCall`

The CLI chooses the fixed chunk size. The request cannot increase it. The App
validates contiguous offsets, total bytes, and SHA-256 before passing HTML to
the frame adapter.

Initial limits are implementation constants, covered by tests and adjustable
without wire changes:

- resource HTML: 5 MiB decoded;
- resource count per View request: exactly one for the primary HTML;
- individual encrypted chunk payload: at most 256 KiB before encryption;
- result payload stored in a conversation event: at most 256 KiB serialized;
- active buffered resources per session: 8;
- resource buffer lifetime: 2 minutes after last access;
- bridge JSON-RPC request: at most 256 KiB serialized;
- bridge requests per View: bounded concurrency and rate limiting.

Limits are defense-in-depth, not promises to App authors. Limit failures
produce static fallback rather than partially executing a View.

`mcpAppResourceOpen` is only for the binding's primary HTML resource. CLI
ignores any caller-selected URI because the request does not contain one.
`resourceId` is an unguessable, session-bound capability with a short lifetime;
chunk reads also verify the owning Paws session and binding before returning
bytes.

### Primary and secondary resource reads

For the primary View resource:

- Trusted Codex App: call `mcpServer/resource/read` with `threadId`, `server`,
  `uri`, and `originCallId = callId`.
- Ordinary configured MCP server: call with `threadId`, `server`, and `uri`.

For a View-initiated `resources/read`:

- The View supplies only `uri` to the Host.
- CLI uses the binding's server and thread.
- For a trusted hosted App, CLI restricts the read using the binding's internal
  connector context where supported by Codex.
- The URI scheme and response size are validated again.
- The separate `mcpAppResourceRead` RPC returns the standard MCP
  `ReadResourceResult`; it does not use the primary HTML response type.
- Secondary responses have a smaller inline byte limit. Oversized secondary
  resources fail with `MCP_APP_RESOURCE_TOO_LARGE`; downloads and streaming
  resources are deferred.

An origin-scoped primary read failure never falls back to an unscoped read.

### View-initiated tool calls

```ts
type McpAppToolCallRequest = {
    callId: string;
    tool: string;
    arguments?: Record<string, unknown>;
    _meta?: unknown;
};
```

The request has no `threadId` or `server`. CLI resolves both from `callId` and
calls `mcpServer/tool/call`.

Before execution, CLI reads or refreshes the thread's MCP tool catalog and
checks:

- the tool belongs to the binding's server;
- `_meta.ui.visibility` is absent or includes `"app"`;
- the tool is still enabled by current Codex configuration;
- the connector context still matches the binding;
- arguments and `_meta` fit configured size/depth limits.

The View cannot override host-generated connector/account metadata. For tool
annotations indicating destructive, non-read-only, or open-world behavior,
Paws uses its existing permission surface before direct execution. A rejected
approval returns a normalized MCP error to the View and does not invoke the
tool.

## Lifecycle

Each tool call owns one View instance. Instances are not shared between cards.

For trusted Codex Apps, `originCallId` provenance becomes readable only after a
successful completed tool call. Paws may show the themed loading placeholder
when the start descriptor arrives, but it must wait for successful completion
before opening the primary resource. Ordinary configured MCP servers may
prefetch their thread-scoped primary resource at start.

```text
fallback
   │ valid descriptor + live CLI
   ▼
waiting-for-origin
   │ trusted call completed successfully, or ordinary server binding ready
   ▼
fetching-resource
   │ bytes + digest + MIME + CSP valid
   ▼
loading-sandbox
   │ sandbox-proxy-ready
   ▼
initializing-view
   │ ui/notifications/initialized
   ▼
send-tool-input
   │
   ├── result already known ──> send-tool-result ──> active
   └── result pending ────────> active-loading ────> send result/cancel

any state ── unmount/session loss/timeout ──> teardown ──> disposed
```

Ordering requirements:

1. Do not send any View request before `ui/notifications/initialized`.
2. Send initial tool input exactly once.
3. Send completed result or cancellation at most once.
4. A result received before View initialization is buffered in host state.
5. Ignore late RPC and bridge responses after disposal.
6. Call bridge resource teardown before removing the frame when possible.
7. Remove listeners, timers, resource buffers, and WebView references on every
   terminal path.

Default timeouts:

- resource RPC start: 30 seconds;
- chunk inactivity: 15 seconds;
- Sandbox Proxy ready: 10 seconds;
- View initialize: 10 seconds;
- View tool call: bounded by Paws RPC and Codex tool timeout.

Timeout values are internal policy, not wire fields.

## Web Frame Adapter

The Web adapter uses `@modelcontextprotocol/ext-apps/app-bridge` and follows the
official double-iframe architecture:

```text
Paws Web origin
  └─ outer iframe: dedicated Paws MCP sandbox origin
       └─ inner iframe: untrusted MCP App HTML
```

The outer Sandbox Proxy must be delivered from a different origin than Paws
Web. A same-origin `srcdoc` iframe with both `allow-scripts` and
`allow-same-origin` is not acceptable.

Deployment requirements:

- Add a dedicated configurable `PAWS_MCP_APP_SANDBOX_URL`.
- Serve a versioned Sandbox Proxy from a dynamic endpoint that validates the
  requested CSP policy and writes the resulting CSP response header.
- Reject CSP entries containing directive separators, quotes, whitespace, or
  unsupported schemes; never concatenate unvalidated resource metadata into a
  header.
- Return `no-store` so a proxy response with one App's policy is not reused for
  another App.
- Allow embedding only from configured Paws Web origins.
- Validate `document.referrer`, `event.source`, and exact `event.origin`.
- Never use `"*"` as the Host/Proxy target origin.
- Self-test that the proxy cannot access the Paws top window.
- Construct CSP from `_meta.ui.csp`, with restrictive defaults.
- Set `object-src 'none'` and block undeclared frame/base/connect/resource
  domains.

The current production Web origin does not yet have this second origin.
Therefore Web MCP Apps remain feature-disabled until the sandbox endpoint and
its deployment contract are implemented and verified. This gate must not be
bypassed with a same-origin development shortcut in production.

## Native Frame Adapter

The native adapter loads a bundled Paws Host Shell into
`react-native-webview`. The shell owns `AppBridge`, creates the inner sandboxed
iframe, and relays allowed bridge requests to React Native through one narrow
JSON channel.

Native WebView configuration:

- load only the bundled Host Shell as the top document;
- block arbitrary top-level navigation;
- disable file access and universal file-URL access;
- disable automatic window opening;
- do not expose arbitrary native methods through injected JavaScript;
- validate every `onMessage` payload with a discriminated Zod schema;
- bind every response to an instance ID and request ID;
- use an inner iframe for the untrusted View rather than writing App HTML into
  the top WebView document;
- deny requested camera, microphone, location, and clipboard permissions in
  v1;
- terminate the WebView instance on bridge protocol violation.

The Host Shell has no account token, session encryption key, filesystem
interface, or direct network bridge. React Native performs encrypted RPC on
its behalf after validating the request.

## Host Capabilities

Advertised v1 Host capabilities:

- inline display mode;
- `tools/call`;
- `resources/read`;
- `ping`;
- `ui/open-link` through host mediation;
- `ui/notifications/size-changed`;
- resource teardown.

Not advertised in v1:

- fullscreen or PiP;
- camera, microphone, geolocation, clipboard write;
- `ui/message`;
- model-context update;
- sampling/create-message;
- file download;
- prompts;
- App-exposed tools and `tools/list_changed`;
- MCP event streams.

Unsupported requests receive a protocol error rather than being silently
ignored.

### Host context

The initialize response includes only values Paws can maintain correctly:

- current light/dark theme;
- current locale;
- platform (`web`, `android`, `ios`, or `desktop`);
- touch and hover capability;
- container dimensions;
- safe-area insets on native;
- inline display mode.

Theme changes and container changes are sent through Host Context updates.
No user ID, machine ID, local path, repository name, or session title is
included.

## Conversation Presentation

`ToolView` keeps the existing compact card as the fallback/header. When
`tool.mcpApp` is present and the platform feature is enabled, it renders an
expanded `McpAppHost` content area below that header.

Presentation rules:

- the App never replaces the tool call title/status;
- initial inline height is a conservative themed placeholder;
- size-change notifications are clamped to product minimum/maximum heights;
- excessive resize frequency is throttled;
- `prefersBorder` influences only the existing themed surface treatment;
- all surrounding colors use Paws semantic theme tokens;
- loading, retry, offline, and error labels use Paws i18n;
- collapsing a card tears down the active View unless an explicit keep-alive
  policy is added later.

Archived/offline behavior:

- show the ordinary MCP tool summary and display-safe result content;
- show that interactive content requires the owning Codex session to be
  online;
- never execute cached HTML actions while CLI is unavailable.

Raw HTML is not stored in the conversation. A later offline replay design may
add a bounded E2EE content-addressed cache, but actions must remain disabled
without a live authority.

## Security Model

### Assets

- Paws account/session credentials.
- Codex/MCP authentication and connector account binding.
- Local machine and repository access available to MCP tools.
- Conversation content and MCP tool `_meta`.
- Paws Web cookies, DOM, and native capabilities.

### Threats and controls

| Threat | Required control |
|---|---|
| View accesses Paws DOM/cookies | Different-origin Sandbox Proxy plus inner sandbox |
| View invokes another MCP server | RPC omits server; CLI resolves immutable binding |
| View changes connector/account | Connector/link context remains in Codex/CLI |
| Resource substitution | `originCallId`, URI match, MIME validation, SHA-256 |
| Origin-scoped read bypass | Never retry trusted primary reads unscoped |
| Model-only tool invoked by View | Catalog visibility check requires `app` |
| Destructive direct tool call | Tool annotations plus Paws approval surface |
| CSP escape | Header-enforced CSP, undeclared domains denied |
| Native bridge abuse | Narrow validated message union; no general JS/native interface |
| Oversized payload/DoS | byte, depth, concurrency, rate, and timeout limits |
| Replay after unmount | instance IDs, abort signals, disposed-state checks |
| Sensitive metadata leak | E2EE only; redacted logs and analytics |
| Arbitrary navigation | Host-mediated HTTPS links and navigation blocking |

### Link policy

- Accept only `https:` in production.
- Permit `http://localhost` only in explicit development mode.
- Reject `javascript:`, `data:`, `file:`, custom schemes, credentials in URLs,
  and malformed URLs.
- Open links using the existing Paws external-link confirmation surface.
- The View never controls the current Paws navigation stack directly.

## Errors and Fallback

Stable Paws error codes:

```ts
type McpAppErrorCode =
    | "MCP_APP_UNSUPPORTED"
    | "MCP_APP_SESSION_OFFLINE"
    | "MCP_APP_BINDING_NOT_FOUND"
    | "MCP_APP_ORIGIN_MISMATCH"
    | "MCP_APP_RESOURCE_NOT_FOUND"
    | "MCP_APP_INVALID_RESOURCE"
    | "MCP_APP_RESOURCE_TOO_LARGE"
    | "MCP_APP_RESULT_TOO_LARGE"
    | "MCP_APP_TOOL_NOT_ALLOWED"
    | "MCP_APP_PERMISSION_DENIED"
    | "MCP_APP_SANDBOX_UNAVAILABLE"
    | "MCP_APP_BRIDGE_PROTOCOL"
    | "MCP_APP_TIMEOUT"
    | "MCP_APP_INTERNAL";
```

The App receives a code, retryability, and display-safe summary. Raw Codex MCP
error `data`, auth metadata, connector IDs, and server stack traces stay in
redacted local diagnostics.

Fallback policy:

- Unsupported client/server: normal tool card.
- Missing/invalid resource: normal card plus display-safe error.
- Offline CLI: normal card plus reconnect action.
- Sandbox/bridge failure: destroy frame, retain normal card, allow one user
  retry for retryable failures.
- Tool-call failure: deliver MCP error to View if active and preserve the tool
  card's failed status.

## Observability

Local structured logs may contain:

- platform;
- lifecycle stage;
- duration;
- byte counts;
- stable error code;
- whether origin scoping was used;
- whether fallback was rendered.

Logs and analytics must not contain:

- HTML or resource bodies;
- tool arguments/results;
- `_meta`;
- resource URI;
- connector/link/account IDs;
- arbitrary App names;
- full MCP errors.

Suggested product events:

- `mcp_app_render_started`
- `mcp_app_render_succeeded`
- `mcp_app_render_failed`
- `mcp_app_tool_call_requested`
- `mcp_app_tool_call_resolved`

Each event contains only platform, lifecycle stage, duration bucket, byte-size
bucket, and stable outcome code.

## Testing Strategy

### `happy-wire`

- old tool events parse without MCP fields;
- new optional fields parse and round-trip;
- old-client fixture ignores unknown optional fields;
- invalid `ui://`, oversized strings, and malformed result shapes fail closed;
- live and replay envelope IDs remain stable.

### CLI unit tests

- initialize advertises exactly the supported MIME type;
- invalid-capability rejection reconnects once with legacy initialization;
- no repeated initialize on one transport;
- live `mcpToolCall` started/completed maps losslessly;
- historical mapping produces the same descriptor/result ordering;
- modern and deprecated resource URI fields normalize correctly;
- `structuredContent` and `_meta` are not stringified;
- binding registry rejects unknown call IDs and server/thread overrides;
- trusted primary resource read always uses `originCallId` and never falls back;
- ordinary MCP server reads remain thread-scoped;
- resource chunk offsets, digest, bounds, expiry, and cleanup work;
- app visibility and destructive-tool approval checks run before direct call;
- transport disconnect aborts pending resource/tool requests.

### App module tests

Tests cross the `McpAppHost` interface using in-memory remote and frame
adapters:

- resource fetch → sandbox ready → initialize → input → result ordering;
- result arriving before initialization is buffered;
- cancellation and failed result are delivered once;
- invalid chunk/digest destroys the instance;
- stale responses after unmount are ignored;
- timeout and retry policy;
- size clamping and resize throttling;
- theme/host-context update;
- offline and unsupported fallback;
- teardown releases every listener and timer.

### Security tests

- malicious View cannot select thread/server/connector;
- cross-server and model-only calls are rejected;
- origin mismatch does not trigger an unscoped retry;
- malformed and oversized JSON-RPC messages terminate the frame;
- undeclared connect/resource/frame domains are blocked;
- `javascript:`, `data:`, `file:`, and custom links are rejected;
- native Host Shell exposes no generic eval/native method;
- Web proxy rejects unexpected referrer, source, and origin;
- Web isolation self-test confirms top-window access throws.

### Integration and UI tests

- generate and parse protocol fixtures from the locally supported Codex
  0.144.5 binary;
- run a real official ext-apps example MCP server through Codex app-server;
- verify one read-only View and one View-initiated tool call;
- verify private stdio and shared Unix-socket app-server modes;
- verify historical resume and live calls render the same App;
- Playwright validates the Web double-iframe Host on its real origins;
- Android preview validates loading, resize, tool action, offline fallback,
  link mediation, and teardown.

Starting servers, browser validation, simulators, OTA publishing, or real-device
validation requires the repository's normal explicit execution/preview gates;
this design document does not perform them.

## Rollout Plan

### PR 1 — protocol alignment and lossless CLI events

- update narrow Codex compatibility types;
- advertise MCP UI extension with fallback;
- handle live `mcpToolCall` items;
- preserve result and App descriptor in live/history mapping;
- centralize optional wire schemas in `happy-wire`;
- add binding registry skeleton and compatibility tests.

No visible UI. `Visible UI cases: 0`.

### PR 2 — encrypted resource bridge and read-only native Host

- implement chunked resource RPC;
- implement `McpAppHost` and native frame adapter;
- support initialize, tool input/result, sizing, teardown, and fallback;
- keep View tool calls disabled;
- add Android UI evidence and preview OTA after normal verification.

### PR 3 — interactive tool/resource calls

- add View `resources/read` and `tools/call`;
- add catalog visibility and tool-annotation approval policy;
- add host-mediated links;
- add rate limits, structured errors, metrics, and security tests.

### PR 4 — Web Sandbox Proxy

- provision/configure the dedicated sandbox origin;
- use official AppBridge and double-iframe architecture;
- add header CSP and exact-origin validation;
- add real-origin Playwright security tests;
- enable the Web feature only after deployment verification.

### Deferred follow-ups

- fullscreen/PiP;
- permitted device capabilities;
- downloads and attachments;
- App tools/list-changed and MCP event streams;
- offline content-addressed E2EE resource cache;
- non-Codex provider adapters;
- Session Protocol v2 representation.

## Expected File Map

Protocol and CLI:

```text
packages/happy-wire/src/sessionProtocol.ts
packages/happy-cli/src/codex/codexAppServerTypes.ts
packages/happy-cli/src/codex/codexAppServerClient.ts
packages/happy-cli/src/codex/utils/sessionProtocolMapper.ts
packages/happy-cli/src/codex/runCodex.ts
packages/happy-cli/src/codex/mcpApps/CodexMcpAppAdapter.ts
packages/happy-cli/src/codex/mcpApps/McpAppBindingRegistry.ts
packages/happy-cli/src/codex/mcpApps/registerMcpAppRpcHandlers.ts
```

App:

```text
packages/happy-app/sources/sync/ops.mcpApps.ts
packages/happy-app/sources/components/tools/McpAppHost.tsx
packages/happy-app/sources/components/tools/mcpApps/types.ts
packages/happy-app/sources/components/tools/mcpApps/remotePort.ts
packages/happy-app/sources/components/tools/mcpApps/WebMcpAppFrameAdapter.web.ts
packages/happy-app/sources/components/tools/mcpApps/NativeMcpAppFrameAdapter.native.ts
packages/happy-app/sources/components/tools/mcpApps/nativeHostShell.ts
packages/happy-app/mcp-app-sandbox/*
packages/happy-server/sources/app/api/routes/mcpAppSandboxRoutes.ts
```

The server route shown above may be replaced by an equivalent dedicated
sandbox deployment, but it must remain a different HTTPS origin from Paws Web
and must generate the validated CSP response header dynamically.

Tests remain colocated with their modules, following package conventions.

## Rejected Alternatives

### Paws App connects directly to MCP servers

Rejected because it duplicates configuration and auth, exposes MCP endpoints
and account context to remote devices, bypasses Codex provenance and policy,
and creates a second connection whose tool catalog may not match the thread.

### Render raw HTML directly in ToolView

Rejected because React HTML injection and a same-origin iframe do not provide
the required MCP Apps isolation, CSP, lifecycle, or auditable bridge.

### Put HTML into conversation messages

Rejected because large untrusted HTML bloats encrypted history, becomes stale,
complicates deletion, and remains unusable for authorized actions while CLI is
offline. Resources are fetched lazily and buffered temporarily.

### Render the App in CLI and send screenshots

Rejected because screenshots are not interactive MCP Apps and cannot implement
View-initiated tool/resource calls or standard lifecycle behavior.

### Treat `structuredContent` as Markdown/JSON only

Rejected as the primary behavior because it discards the server's declared
`ui://` presentation. Structured/text content remains the fallback.

### Extend Session Protocol v2 first

Rejected as a dependency because MCP Apps can be added compatibly through
optional fields in the active protocol. Coupling the feature to the larger v2
migration would expand scope without improving Host security.

## Acceptance Criteria

The first interactive release is complete only when all of the following are
true:

- Codex receives the exact MCP UI extension declaration.
- Old Codex versions and old Paws clients retain ordinary tool-card behavior.
- Live and historical MCP tool calls preserve App descriptor and full result.
- Paws App never receives MCP credentials or connector/link identifiers.
- Trusted primary resource reads always use Codex `originCallId` provenance.
- HTML is validated, bounded, digested, and transferred over E2EE RPC.
- Android/native uses a Host Shell plus inner sandboxed View.
- Web uses a different-origin Sandbox Proxy; same-origin production rendering
  is impossible by construction.
- Tool calls are bound to the originating thread/server and require app
  visibility.
- Destructive/non-read-only direct calls pass through Paws approval.
- `_meta`, HTML, arguments, results, and raw MCP errors are absent from logs and
  analytics.
- Offline, timeout, unsupported, and invalid-resource paths preserve a usable
  static tool card.
- Teardown removes all View capabilities and ignores late responses.
- Relevant wire, CLI, Host-interface, security, integration, and platform tests
  pass.

## Effort Estimate

Expected production effort for one experienced engineer:

- protocol/CLI alignment: 2–3 days;
- native read-only Host: 4–6 days;
- interactive operations and hardening: 4–6 days;
- Web sandbox origin and Web adapter: 3–5 days;
- cross-platform verification and rollout fixes: 2–4 days.

Total: approximately 3–4 engineering weeks. A native read-only demonstration
can be delivered in roughly one week, but it is not equivalent to production
MCP Apps support.
