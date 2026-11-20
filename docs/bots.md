# Paws Bots

Bots sits immediately below Home in the Paws navigation. It opens the pinned
[Rakazo](https://github.com/elie222/rakazo) application: its own bot list, chat,
groups, mentions, memory, routines, API, worker and PostgreSQL database. Paws is
created as each account's pinned chief bot with native fleet management enabled.
Paws does not implement a second conversation or inference engine.

The former Personal implementation is retired. Its App/profile/runtime code and
CLI command have been removed. Historical Personal sessions, saved configuration,
drafts and pending messages are preserved; old routes lead to Bots and old CLI
commands fail explicitly. They cannot silently resume with a coding agent.

## Runtime and identity

The source revision, official application image and database image are pinned in
[`upstream.lock.json`](../integrations/rakazo/upstream.lock.json). See
[runtime setup](../integrations/rakazo/README.runtime.md) for the native Docker
stack and [gateway setup](../integrations/rakazo/gateway/README.md) for the private
authenticated bridge.

Each authenticated Paws account maps to a separate native Rakazo account and
space. The Web host mounts the source in `packages/paws-bots/apps/web` directly in its
document, with a private React root, scoped CSS and MemoryRouter. The mount gets
a short-lived, single-use launch ticket. The Paws bearer
token never goes to Rakazo or into the DOM/asset URL. The gateway holds native
sessions privately in memory and validates the account before reusing one.
Changing accounts disposes of the previous mount, aborts its requests and revokes
its lease; saved drafts and internal routes are isolated per account and native space.

The host loads scoped CSS and the workspace script in parallel. It reuses the
versioned stylesheet on return; each mount executes a fresh library instance so
authentication, calls and preference state never cross account lifecycles.
Immutable script URLs use the browser HTTP cache. Leaving Bots still unmounts
the UI and releases its resources.

The runtime needs a dedicated root HTTPS origin, separate from the Paws origin.
Its native API/Web listeners remain private. Only the gateway may be exposed by
an operator-managed HTTPS reverse proxy, with exact allowed parent origins.
The Paws server must reach the bootstrap on private loopback; a remote server
requires a separately configured private transport. Running the local Docker
stack does not configure or publish a production deployment.

The default model uses the existing local OpenAI-compatible gateway, with model
ID `codex/gpt-6.1-sol`. This is a local model gateway configuration; this feature
does not download or run GPT model weights on the host.

## Supported boundaries

- Web uses no application iframe and installs no Service Worker. It calls the
  private gateway through exact-origin CORS with its own bound lease. Missing
  release assets or failed authorization fail closed with an explicit retry.
- Android/iOS WebView code has not passed device acceptance. Web verification
  does not establish native compatibility or offline support.
- The core-only stack keeps computers disabled. The explicitly selected
  `compose.monorepo.yml` overlay enables a private Docker supervisor and isolated
  Linux desktop with Chromium/chrome-use. Its Docker socket stays in the
  supervisor; no host-shell fallback is added. Desktop screens use sealed noVNC
  capabilities; the application UI itself is mounted directly.
- The Web bridge uses native SSE and bounded fetch, with one-shot expiry/timeouts;
  it adds no business-state polling. This statement concerns the Bots bridge,
  not every existing Paws or upstream background process.
- Third-party integration screens are upstream UI. OAuth/provider authorization
  through the embedded gateway has not been accepted yet; no existing provider
  account is automatically connected by this feature.

## Verification

```sh
node --test scripts/bots-runtime.test.mjs integrations/rakazo/gateway/*.test.mjs integrations/rakazo/stack.test.mjs
pnpm --filter happy-server-self-host exec vitest run sources/bots
pnpm --filter happy-app exec vitest run sources/components/bots \
  sources/components/SidebarView.test.tsx \
  sources/components/SidebarNavigator.test.tsx \
  sources/components/DesktopSidebarSessionsNavigation.test.tsx
```

The full-App fixture in `packages/happy-app/e2e/fixtures/bots/serve.mjs` uses an
isolated Paws database and synthetic accounts, and connects to the actual native
Rakazo services and local GPT gateway. It starts no daemon or computer. Provide
the private `gateway.env` path in `PAWS_BOTS_QA_GATEWAY_ENV` when starting it via
`pnpm exec tsx`; credentials and authenticated URLs are saved only in ignored
private files. Browser acceptance must use the authorized Ego workflow.

## Production ingress

The existing main-only Web deployment configures the dedicated Bots origin at
`https://47.115.228.20:8445`, forwarding to the Mini's private Tailnet ingress.
It reuses the production-web environment's existing verified SSH identity. The
configurator reads the current Caddyfile and its adapted configuration, requires
the existing IP certificate and an unclaimed port, and preserves all other sites.
The native gateway must be running before release activation. The ingress itself does not enable a sandbox provider; that choice belongs to
the explicit computer overlay.

Each deployment uses a run/attempt-specific backup. A later Web failure restores
the Web, Bots, then MCP configuration in reverse preparation order. A transport
failure with an unknown remote outcome requires reading the effective remote
configuration before retrying; the tests do not claim distributed transactions.

## Source builds

See [`packages/paws-bots`](../packages/paws-bots/README.md) for workspace boundaries
and build commands. Web release HTML pins immutable Bots JS/CSS in `/assets/bots/`;
Expo development serves the generated files under `/bots-assets/`. Never reuse
production gateway ports for fixtures; the default QA gateway is loopback 3492.


### Source QA computer network isolation

The source Compose overlay uses `SANDBOX_COMPUTER_EGRESS=proxy`. Each computer
has an IPv4-only Docker `internal` bridge with `gateway_mode_ipv4=isolated`:
there is no default route and no bridge address on the Docker host. A separate
unprivileged `computer-egress` service supplies HTTP/HTTPS proxy access to public
IPv4 destinations on ports 80 and 443. It receives no application credentials,
Docker socket or user-data mounts, and kernel IP forwarding is disabled.

The proxy checks every DNS answer, rejects non-public addresses (including
loopback, LAN, Docker host and cloud metadata), and connects to the checked IP
without resolving again. Chromium receives the same explicit proxy setting as
command-line HTTP clients. Direct networking, IPv6 and non-HTTP protocols remain
unavailable; stopping the proxy does not add a direct route. A missing proxy or
an existing network with incompatible settings prevents computer provisioning.
Use a Docker daemon that supports isolated gateway mode; an unsupported daemon
must fail provisioning. Do not fall back to `auto` or `open`.

The upstream `restricted` host-firewall script requires a supported Linux Docker
host and does not support Docker Desktop. Screen access isolation alone does
not establish an outbound network boundary.

Checks: `node --test integrations/rakazo/egress/public-proxy.test.mjs`, the
supervisor `proxy-egress.test.ts` and `computer-spec.test.ts`, and a real Docker
network check of direct host/LAN/metadata/peer denial, public HTTPS with TLS
verification, and denied direct access after proxy disconnection. Browser UI
acceptance follows the repository's Ego rules separately.


### Monorepo activation order

Prepare the source services and upgrade the gateway before activating the Web
bundle. The embedded client requires the gateway's stable `accountKey`, restricted
CORS for sealed computer probes, and the exact HTML/MCP viewer-shell ancestor
policy. These gateway changes remain compatible with the previous iframe client.
Keep the original deployment available for rollback. A successful frontend build
alone does not activate source API/worker services or enable computers.

The HTML/MCP viewer shells stay on the Bots gateway origin. Only their two exact
public shell paths may be framed by configured Paws parent origins; their own
script/network CSP, opaque sandboxes and source-window message checks remain in
force. They are deliberately not copied under `/assets/`, whose production route
redirects immutable files to OSS.

The root development dependencies pin the primary Server's Prisma 6 CLI and
client together. With the hoisted linker, a package-local Prisma 6 CLI and a
root-level client otherwise trigger Prisma's implicit package installation from
inside postinstall. Bots DB keeps its explicitly declared Prisma 7 toolchain and
separate generated output; do not use a global Prisma override to merge them.

## Web session steward (source implementation)

The pinned Paws chief can use `paws_sessions_list`, `paws_session_read`,
`paws_session_send`, `paws_session_resume` and `paws_session_result` in its owner's
Web conversation. These are coding-session tools, separate from Rakazo fleet tools.
They reuse the logged-in Paws host's authentication, encryption and existing send /
resume operations. No Paws bearer or account secret is passed to Bots. Selected
history and tool results intentionally enter the Bots backend/model conversation.

The gateway carries bounded reverse RPC over one lease-bound SSE connection.
Listing returns a non-secret `connectionId`; subsequent tools must use that routing
nonce. It pins reads, writes and result tracking to the same tab. A disconnected
nonce cannot be rebound, so an uncertain write cannot automatically execute in a
new tab. Pending work fails closed on disconnect, lease expiry or sign-out. The
Web callback also fences asynchronous send/resume against account/server switches.
Read requests are discarded after settlement; write receipts live only for that
connection, bounded per client, and are removed on disconnect. The Bots durable
effect/approval journal remains responsible for worker retry safety across restart.

`paws_sessions_list` uses server pagination, not the 150-row SDK list or the visible
sidebar. History reads decrypt detached pages without navigating or moving the
user's scroll position. Metadata/status are authoritative server snapshots; online
presence remains the existing Web connection observation. The model must separate
execution outcomes from tests/deployment/acceptance evidence. History is untrusted
input, and send/resume use the existing consequential-action approval policy.

A send receipt means **queued**, not accepted by the remote agent. Results match
accepted `localIds` in `turn-start` and the same root turn's `turn-end`; idle state,
other turns, subagents and legacy events without that link cannot prove completion.
Result waits subscribe before reading history, wake only on store changes and have
one 20-second deadline. There is no polling or automatic mutation retry. Closing
Bots stops follow-up, but does not undo instructions already delivered remotely.
Resume acknowledges original-session launch only and never replays an old prompt.

### Activation and verification boundary

The source worker overlay accepts optional `PAWS_BOTS_SESSION_TOOLS_URL` (a trusted,
fixed root gateway URL reachable **from the worker**) and `PAWS_BOTS_BRIDGE_SECRET`
(the existing gateway bootstrap secret). These are server environment values,
never bot secrets or model arguments. Keep the gateway private; do not change its
loopback binding or expose a host port to make a test pass. Configure an existing
verified private transport if worker and gateway are on different hosts/networks.
Missing configuration leaves the tools unavailable. No production environment or
service is changed by this source patch. Native clients do not install the callback.

Upgrade the gateway and source worker along with the embedded Web assets. A Web
bundle alone does not activate the feature. Before claiming live acceptance, verify
worker→gateway reachability, real owner-only tool calls, account switch while a grant
is pending, full paginated history, exact completion, and a real remote resume.

Targeted source checks:

```sh
node --test integrations/rakazo/gateway/*.test.mjs
pnpm --filter happy-app exec vitest run sources/components/bots sources/sync/apiSocket.test.ts sources/sync/ops.codexAccounts.test.ts
pnpm --filter @rakazo/adapters exec vitest run --root ../.. packages/adapters/src/paws-session-tools.test.ts
pnpm --filter @rakazo/web exec vitest run --root ../.. apps/web/src/paws
```
