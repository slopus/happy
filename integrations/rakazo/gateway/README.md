# Native Rakazo gateway for Paws Bots

This is an authentication and transport bridge to the pinned Rakazo distribution,
not another bot engine. Native Rakazo owns users, spaces, bots, conversations,
jobs, permissions and files. Paws authenticates a launch and displays the full
native web application at a **separate, dedicated root origin**.
Startup and the Paws launch response both reject a runtime origin equal to the
Paws parent origin, so a root worker cannot accidentally claim the Paws app.

## Configuration

All upstream listeners and the gateway listener must remain private. The gateway
binds `127.0.0.1`; an operator-managed HTTPS reverse proxy exposes only the
dedicated runtime origin. Never expose the native API or web listener separately.
No reverse tunnel or public deployment is created by these scripts.

Gateway environment:

```dotenv
PAWS_BOTS_GATEWAY_PORT=3490
PAWS_BOTS_PUBLIC_ORIGIN=https://bots.example.com
PAWS_BOTS_ALLOWED_PARENT_ORIGINS=https://paws.example.com
PAWS_BOTS_BRIDGE_SECRET=<32-or-more-random-characters>
PAWS_BOTS_IDENTITY_SECRET_FILE=/private/path/gateway-identity-secret
PAWS_BOTS_IDENTITY_REALM=paws
RAKAZO_WEB_URL=http://127.0.0.1:15730
RAKAZO_API_URL=http://127.0.0.1:15731
RAKAZO_AUTH_ORIGIN=http://127.0.0.1:15730
```

The identity secret file must have mode `0600` and at least 32 characters. Keep it
stable and include it in private deployment backups. Subject + realm determine a
stable native email and chief Bot ID; the secret derives its password. Rotating
the secret cannot silently replace an existing account: native sign-in/signup
fails instead. It never deletes old history. Account recovery/secret rotation
needs a deliberate native migration. Never commit either secret.

The native server must permit backend password sign-up, with no email allowlist
requiring delivery. Browser sign-up/sign-in/credential mutations are blocked by
this gateway. The native API must not be publicly reachable; this is part of the
security boundary, not optional hardening.

Paws server environment:

```dotenv
PAWS_BOTS_GATEWAY_BOOTSTRAP_URL=http://127.0.0.1:3490/__paws/bootstrap
PAWS_BOTS_BRIDGE_SECRET=<same-bridge-secret>
PAWS_BOTS_ALLOWED_PARENT_ORIGINS=https://paws.example.com
```

The Paws server must reach the gateway over a private loopback transport. This
implementation intentionally refuses arbitrary remote/bootstrap URLs. A remote
Paws server needs an explicitly deployed private bridge; displaying a public
runtime URL alone does not provide that bridge. Missing configuration returns
`503` only on the Bots launch route.

Run on Node 22+:

```sh
node --env-file=/private/path/gateway.env integrations/rakazo/gateway/server.mjs
node --test integrations/rakazo/gateway/*.test.mjs
pnpm --filter happy-server-self-host exec vitest run sources/bots
```

## Launch contract

`POST /v1/bots/launch` requires normal Paws authentication:

```json
{"parentOrigin":"https://paws.example.com","platform":"web","locale":"zh","appearance":"dark"}
```

It returns `{runtimeUrl, ticket, expiresAt}`. `runtimeUrl` is the runtime origin
with a trailing `/`; it contains no credentials, query or fragment. `expiresAt`
is UTC epoch milliseconds. Tickets expire after 60 seconds and are single use.

Paws server forwards only its verified subject and a server-to-server bridge
secret to `/__paws/bootstrap`. It never forwards the Paws bearer token. Concurrent
launches for the same subject share account bootstrap; cancelling one waiter
does not cancel another. A disconnected waiter is not issued a ticket.

Native signed sessions are held in a bounded, per-subject process-memory LRU
cache (at most 1,000 accounts). Every launch verifies that account's cookie with
native `get-session?disableCookieCache=true`, checking the expected account ID,
email and expiry. Only a revoked/expired/missing session triggers another native
credential sign-in. Verification rate limits or outages fail the launch without
submitting more credential requests. This preserves Rakazo's production sign-in
limits during ordinary refresh/navigation. A gateway process restart clears this
cache; the first sign-in still obeys the native service's existing rate window.
No native cookie is written to disk or logs.

Web handshake:

1. Load `runtimeUrl` in an iframe. Its native module scripts are initially inert.
2. Runtime posts `{type:"paws:rakazo:ready"}`. The parent verifies the exact runtime
   origin **and** `event.source === iframe.contentWindow`.
3. Parent posts `{type:"paws:rakazo:launch",ticket}` to the exact runtime origin.
   The runtime accepts messages only from its actual parent window. The gateway
   independently checks the ticket's configured parent origin and platform.
4. After ticket redemption and worker binding, runtime posts
   `{type:"paws:rakazo:authenticated"}` and starts native module scripts.
   Errors post `{type:"paws:rakazo:error",message}`. This event confirms bridge
   authentication; it does not replace a real native UI/business acceptance test.

For a native WebView use `platform:"native"`. With `ReactNativeWebView` present,
runtime publishes `window.__pawsRakazoLaunch(ticket)` and returns handshake events
through `ReactNativeWebView.postMessage(JSON.stringify(event))`. The native host
must validate the exact document origin before injecting the function call and
on every received message/navigation. Native tickets still require redemption;
the native branch does not bypass account authentication.

Use a new launch for a new iframe/WebView document. A consumed ticket cannot
authenticate a reload. Changing Paws accounts must dispose of the old frame.

## Isolation and native behavior

Each Paws subject has its own native account and space. Bootstrap uses native
`bots/create` with stable `spawnKey`, `fleetManagement:true`, then native
`bots/update` to pin Paws as chief. Existing chiefs are reused without calling
`bots/create` again (native create queues an intro run). Deployment-level native
model configuration selects local GPT; this bridge does not override user model
choices or run its own inference loop.

The root `/sw.js` replaces Rakazo's offline PWA worker, so there is no competing
root worker and no private/offline cache. It binds an in-memory gateway lease to
the sending browser **clientId**, adding a private header on `/api` and `/rpc`
requests. Gateway maps that key to the real native signed-session cookie,
strips browser cookies/auth headers and upstream `Set-Cookie`, and streams the
native response. New/unknown documents have no fallback account. When a browser
terminates an idle worker, the new worker may ask only the exact requesting
document for its own lease over a one-time MessageChannel. The document keeps
that lease in a JS closure. Nothing stores it in URL, localStorage, sessionStorage
or a cookie. If both document and worker lose memory, a new authenticated launch
is required. Native browser storage/session broadcast hints are scoped to frame
memory to keep simultaneous Paws accounts from sharing selected-space state.

Only native sealed `/novnc/session/view|control/...` WebSocket upgrades are
forwarded, with the original native sealed-capability validation left intact.
The native screen iframe deliberately has an opaque origin; the literal WS
`Origin: null` is accepted only on that strict capability envelope. Stock noVNC's
extra leading slash is normalized only for those screen paths. Other WS routes
are rejected. This compatibility test does not prove a real desktop/provider
connection. Screen
capabilities are still credentials; never log or publish their URLs. This bridge
does not enable a computer provider: Docker/isolated-computer configuration and
authorized browser tooling are separate prerequisites. In `SANDBOX_PROVIDER=none`
the native chat/bot UI works but computers are unavailable.

SSE is streamed without aggregation and disconnects destroy the upstream stream.
Signing out synchronously revokes every active private stream for that lease;
a single expiry deadline also closes already-open streams when a lease expires.
All requests construct upstream URLs under fixed origins, and normalized paths
that could introduce another authority are rejected before forwarding.
There is no business-state polling in the bridge. Root shell framing permits only
the configured exact Paws parent origins, preserving other native CSP directives.
Static assets are anonymous; private API/RPC requests require a live lease.

Browser support still needs real verification: secure-context Service Workers
must be allowed in the embedded document. Browsers/WebViews that disable them
show a clear startup error. The bridge intentionally fails closed rather than
falling back to a shared cookie/account. Native offline PWA functionality and
native credential management are not available inside this embedded surface.
