# Team servers behind SSO

A team runs Happy Agent on its own server, behind an HTTPS load balancer
that may enforce the organization's single sign-on. The app adds such a
server by its address and signs in with the server's own OAuth method. It
doesn't need Tailcat, Happy Cloud, WorkOS or the hosted relay. The daemon
side is specified in happy-agent's `API.md` ("Signing in with the
authorization code flow") and the edge SSO contract shared by iOS, Android
and desktop.

The code is in `Sources/HappyCore/ServerSignIn/`. The screen is
`Screens/ServerSignInScreen.swift`, reached from the scanner's ⋯ ("Sign in
to a server") wherever an account or agent is added. There is no managed
app configuration: Tailcat, the hosted relay and phone pairing are the
server's to turn on or off (`happy.toml`), and analytics is the person's
choice. The phone pairs only from a code the computer shows, which it
doesn't show while pairing is off there; a code scanned anyway is refused
by the server with `unsupported`, and the app says "Phone pairing is
turned off on this server." (`PairingError.turnedOff`).

## Redirect URI (allow-list exactly this)

**`happy://oauth/callback`**: the same for every Happy app and flavor
(iOS, Android, desktop; production, preview, dev), per edge SSO contract
v2. Allow-list it in the organization's identity provider for the public
OAuth client named by `[feature.team.jwt] client_id`.

Every iOS variant already registers the `happy` scheme
(`CFBundleURLTypes`). `ASWebAuthenticationSession` takes the redirect
itself (`callback: .customScheme("happy")`), and `AppCoordinator.open`
ignores any stray `happy://oauth/callback` so Happy link handling never
sees it (`OAuthRedirect.isCallback`). The exact string goes out as
`redirect_uri` on both the authorization and token requests, with no query
and no fragment. When several flavors share a phone, the wrong one may
receive a redirect; its state check refuses it. Universal links are not
used.

## Sign-in

1. The person enters `https://host[:port]`.
   `ServerURL.normalize` accepts only an `https` origin.
2. `GET /v0/authentication` (`ServerDiscovery`) runs without a token and
   doesn't follow redirects. A redirect (3xx but not 304), a 401 or a non-JSON 403 here means the
   load balancer didn't let discovery through, and the screen says so.
   Methods of a type the app doesn't know, or with insecure URLs, are left
   out.
3. `ASWebAuthenticationSession` opens `authorizationUrl` with
   `response_type=code`, `client_id`, `redirect_uri`, `state`, an S256 PKCE
   challenge, `scope`, and `resource` (RFC 8707) when discovery gives one.
   The session isn't ephemeral, so the organization's SSO cookie in Safari
   is reused.
4. The code goes to `tokenUrl` as a form (`OAuthTokenClient`, through
   `NoRedirectURLSessionTransport`, which refuses redirects), with
   `resource` when present.
5. `GET /v0/authentication` with the new token confirms
   `authenticated: true`. When `userId` is null, the server hasn't met this
   person yet: the app asks for a name and saves it with
   `PATCH /v0/profile` before keeping the account. Otherwise the team-mode
   profile gate would answer 401 to everything.
6. `AccountController.addServer` keeps it as an agent connection
   (`AgentConnection.server` is the origin) and opens it.

## Credentials

- The access token lives in memory only (`ServerAuthorization`).
- The grant lives in the Keychain inside the account's
  `happy-ios:direct-device` item (`AgentConnectionCredentials.signIn`,
  `kSecAttrAccessibleWhenUnlocked`). It holds the refresh token, the
  refresh URL, the client ID and the resource recorded at sign-in. A
  refresh token goes only to that recorded URL with that client and
  resource, never to a URL a daemon advertises later.
- A refresh happens 60 seconds before `expires_in` runs out and after a
  401, and concurrent requests share one refresh. A rotated refresh token
  replaces the old one; when the answer has none, the old one stays.
- The bearer travels only in `Authorization`. That covers JSON requests,
  the SSE stream, WebSocket upgrades and the artifact proxy. It is never in
  a query string, a cookie or a subprotocol. The daemon transport is raw
  HTTP/1.1 over verified TLS and never follows redirects. A signed-in
  server's origin never changes: `AgentEndpoint` ignores the daemon's
  advertised `publicUrl` for it.

### "Sign in again"

`SignInRequired.check` decides, and `SignedInTransport` applies it to every
response, stream head, tunnel refusal and WebSocket upgrade:

- any redirect (`3xx` other than `304 Not Modified`), any `401`, or a `403` that isn't Happy's JSON (`Content-Type:
  application/json` plus an object whose `error` and `code` are strings);
- a `401` with Happy's JSON first asks `GET /v0/authentication` with the
  same token (contract v2):
  - not authenticated: refresh once and repeat;
  - authenticated as a known user: transient, repeat once;
  - authenticated with `userId: null`: the team profile gate. Signing in
    again gets past it, because the sign-in screen asks for the name and
    saves it with `PATCH /v0/profile`;
- a `401` that isn't Happy's JSON came from the edge and needs signing in
  at once, without discovery or refresh;
- the rest, or a refresh the authorization server refuses, sets
  `ServerAuthorization.state = .needsSignIn`. From then on nothing is sent
  to the server or the token endpoint, and callers see a plain 401: the
  account shows "Sign in again" in Settings, and its chat says the sign-in
  has ended. A refresh that fails only on the network keeps the grant.

A 403 with Happy's JSON is an ordinary permission error.

## Tunnels without CONNECT

Previews (the in-app browser's workspace proxy) need a tunnel.
`AgentTransport.proxyTunnel` picks one, and for an HTTPS server
(`ProxyTunnels.swift`) the choice is remembered per origin:

- `capabilities.webSocketTunnels` from health: `GET <route>/websocket`,
  upgraded with the bearer in `Authorization` (`WebSocketTunnel`). Binary
  messages carry the CONNECT tunnel's bytes. Messages are at most 1 MiB
  (writes are split at 256 KiB), a zero-length message is a half-close, a
  text message is a protocol error, and a refusal is the same HTTP error
  its CONNECT twin would give.
- without it, CONNECT. A refusal that isn't Happy's JSON, or a connection
  dropped without an answer, marks the origin `blocked` until the app
  restarts. The browser then shows "Previews Aren't Available: This
  server's network doesn't allow previews" instead of retrying.
- Tailcat transports keep CONNECT to the daemon itself.

## Keepalive and resume

- SSE `/v0/events/stream`: the daemon sends a heartbeat every 15 s. The
  stream is dead after 40 s with no bytes (`AgentClient.silence`) and
  reconnects with `Last-Event-ID`. For a signed-in server the backoff is
  0.1 s doubling to 10 s. `hello.gap` reconciles REST snapshots.
- WebSocket tunnels: the app pings every 20 s and answers the daemon's
  pings. A tunnel is dead after 45 s with nothing inbound. Tunnels can't be
  resumed: WebKit opens a new one.

## Tests

`Tests/HappyCoreTests/ServerSignInTests.swift`: the authorization URL and
PKCE, the code and refresh forms, rotation, discovery filtering, the
needs-sign-in rule, URL normalization,
refresh-and-retry, a single shared refresh, the WebSocket handshake and
framing, and tunnel classification.

`scripts/edge-sso-mock/server.mjs` plays the load balancer, the identity
provider and the daemon in one Node process: HTTPS on 8443 (certificates
from `certs.sh`) and the same on plain HTTP on 8444. Without a valid
bearer everything but discovery is a `302` to the IdP, CONNECT is a `405`
HTML page, and `/control/expire`, `/control/revoke` and `/control/restore`
expire every access token, end the SSO session, or let it sign in again.
It accepts only `happy://oauth/callback`, PKCE S256 and the `resource`.

- `EdgeMockInteropTests` runs the real code flow, rotation, an edge
  refusal and a WebSocket tunnel against it: start the mock, then
  `HAPPY_EDGE_MOCK_PORT=8444 swift test --filter EdgeMockInteropTests`.
- `scripts/edge-sso-mock/run-ui-test.sh` (on a Mac) runs
  `ServerSignInUITests` in a simulator that trusts the mock's CA: the
  address is entered from Start's scanner, sign-in goes through
  ASWebAuthenticationSession, the name prompt answers the profile gate,
  home loads, expired tokens refresh, an ended SSO session shows "Sign in
  again", and signing in again connects.
- `testDiscoveryAnsweredByTheEdgeOnADevice` runs on a phone with
  `TEST_RUNNER_HAPPY_EDGE_DEVICE=1`: a plain website answering
  `/v0/authentication` is refused with the administrator's fix.
