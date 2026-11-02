# Team servers behind SSO

A team runs Happy Agent on its own server, behind an HTTPS load balancer
that may enforce the organization's single sign-on. The app adds such a
server only by scanning the code Happy Desktop shows, and signs in with
the server's own OAuth method. It never takes a typed or pasted address. It
doesn't need Tailcat, Happy Cloud, WorkOS or the hosted relay. The daemon
side is specified in happy-agent's `API.md` ("Signing in with the
authorization code flow") and the edge SSO contract shared by iOS, Android
and desktop.

The code is in `Sources/HappyCore/ServerSignIn/`. The screen is
`Screens/ServerSignInScreen.swift`, opened by a scanned server code (any of
the app's scanners) and by "Sign In Again" in Settings. It shows the server
but doesn't let it be edited. There is no managed
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

## The server code

Happy Desktop shows `happy://<instanceId>/server?url=<percent-encoded base
URL>` (edge SSO contract v5 §8), for example
`happy://k3x9q2m7p0a4b8c1d5e6f7g2/server?url=https%3A%2F%2Fhappy.acme.example%2F`.
It carries no token, code or secret. `ServerLink` (HappyWire) parses it:

- `instanceId` matches `^[a-z][a-z0-9]{23}$`;
- `url` is percent-decoded as UTF-8, any valid escape in either case. The
  result must already be a normalized https base URL, as
  `new URL(u).href === u` would have it: no userinfo, query or fragment, a
  lowercase host, no default port, a path ending in `/`. A path prefix is
  allowed;
- nothing else: no other parameter, no fragment, no `/` after `server`, at
  most 4,096 characters. Anything else is malformed ("Can't Use This
  Code") and never repaired.

It isn't a Happy link: `HappyLink` refuses it, and in a conversation or a
document it is inert text. What happens to one (`HappyScan`):

1. Only a code from the app's own scanner is acted on. One opened from
   another app or a browser, or pasted, says "A server code works only
   when you scan it" and adds nothing.
2. A connected server already reporting that `instanceId`
   (`InstanceLinkRoute.connection`) is shown, and nothing is added.
3. A base URL with a path other than `/` stops here: "This server is set
   up under a web address path, which Happy on iPhone can't connect to
   yet." The transports address a server by origin; prefixes are a
   follow-up.
4. Otherwise the sign-in screen opens on the code's origin, and the
   sign-in below runs. After it, `GET /v0/health` with the new token must
   report the code's `instanceId` (the edge blocks health without one).
   Another installation's, or none, discards the credential and shows
   "This code doesn't match the server it points to."
   (`ServerSignInError.wrongServer`).

"Sign In Again" checks the `instanceId` the connection last reported the
same way; a connection from an older daemon that never reported one isn't
checked.

## Sign-in

A fresh install needs nothing else first: no paired computer, Happy
account or Happy Cloud sign-in. The first screen's Start opens the scanner,
and a server code scanned there signs in and lands on the server's home.

1. The server comes from a scanned code, or from the connection signing
   in again.
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
   `authenticated: true`, and health is checked against the code's
   `instanceId` (above). When `userId` is null, the server hasn't met this
   person yet: the app asks for a name and saves it with
   `PATCH /v0/profile` before keeping the account. Otherwise the team-mode
   profile gate would answer 401 to everything.
6. `AccountController.addServer` keeps it as an agent connection
   (`AgentConnection.server` is the origin) and opens it.

## Credentials

- The access token lives in memory only (`ServerAuthorization`).
- The grant lives in the Keychain inside the account's
  `happy-ios:direct-device` item (`AgentConnectionCredentials.signIn`). It
  holds the refresh token, the refresh URL, the client ID and the resource
  recorded at sign-in. The item is device-only and app-private:
  - `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: readable after the
    first unlock since boot, so a refresh works in the background. A
    ThisDeviceOnly item is never migrated to another device: it isn't in
    an unencrypted backup, and an encrypted backup restores it only onto
    the same phone. Quick Start and iCloud restores to a new phone leave
    it behind, and the person signs in again there;
  - `kSecAttrSynchronizable` false: never in iCloud Keychain;
  - no `kSecAttrAccessGroup`, and no `keychain-access-groups`
    entitlement in any target, so it is in the app's own default group
    (team ID + bundle ID);
  - no `SecAccessControl`: no biometry or passcode prompt.

  An item an earlier build wrote with looser protection is rewritten this
  way (`SecItemUpdate` of the data and `kSecAttrAccessible`) the next time
  the grant is saved. Paired computers' items keep
  `kSecAttrAccessibleWhenUnlocked`. `ServerTokenKeychainTests` checks the
  attributes. A
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

## Instance links

A Happy link that leaves the app names the installation it came from:
`happy://<instanceId>/<internal link without "happy://">`, such as
`happy://k3x9q2m7p0a4b8c1d5e6f7g2/artifacts/abc123?version=2` (edge SSO
contract §7). `HappyLink` (HappyWire) reads and writes the grammar,
ported from happy-agent-client's `happyLinks.ts`.

- Each connection's `instanceId` comes from `GET /v0/health` in the
  identity loop (`AgentIdentity`) and is kept on its `AgentConnection`. An
  older daemon reports none.
- A link from outside (`AppCoordinator.open`) goes through
  `InstanceLinkRoute`: it opens only on the connection with that exact
  `instanceId` (the one in use first, if several), switching to it, and
  shows the artifact or conversation it names; anything else it names
  shows that connection's home. An unknown installation says "This link
  belongs to a Happy server you're not connected to." and never falls back
  to another server. A link naming no installation isn't opened from
  outside. The app's own `happy://` routes (`direct`, `terminal`, `oauth`,
  and the server code) aren't instance links.
- Copy Link, in the bar of an artifact and of a conversation's detail,
  writes the instance form, and isn't offered when the daemon reports no
  `instanceId`.

## Tests

`Tests/HappyCoreTests/ServerSignInTests.swift`: the authorization URL and
PKCE, the code and refresh forms, rotation, discovery filtering, the
needs-sign-in rule, URL normalization, the server code's `instanceId`
checked after sign-in, refresh-and-retry, a single shared refresh, the WebSocket handshake and
framing, and tunnel classification.

`scripts/edge-sso-mock/server.mjs` plays the load balancer, the identity
provider and the daemon in one Node process: HTTPS on 8443 (certificates
from `certs.sh`) and the same on plain HTTP on 8444. Without a valid
bearer everything but discovery is a `302` to the IdP, CONNECT is a `405`
HTML page, and `/control/expire`, `/control/revoke` and `/control/restore`
expire every access token, end the SSO session, or let it sign in again.
It accepts only `happy://oauth/callback`, PKCE S256 and the `resource`.

`Tests/HappyWireTests/ServerLinkTests.swift`: the server code's grammar,
formatting, and every malformed form. `ScanRouteTests` routes it from any
scan.

- `EdgeMockInteropTests` runs the real code flow, rotation, an edge
  refusal and a WebSocket tunnel against it: start the mock, then
  `HAPPY_EDGE_MOCK_PORT=8444 swift test --filter EdgeMockInteropTests`.
- `scripts/edge-sso-mock/run-ui-test.sh` (on a Mac) runs
  `ServerSignInUITests` in a freshly erased simulator that trusts the
  mock's CA. The
  simulator has no camera, so each launch hands the scanner its code with
  `HAPPY_SIMULATED_SCAN` (debug builds only). A code under a path prefix is
  refused before any request, the code opened as a link is refused, a code
  naming another installation is refused after sign-in, then the right
  code (lowercase escapes), scanned from the first screen, signs in through
  ASWebAuthenticationSession, the name prompt answers the profile gate,
  home loads, a kill and relaunch comes back signed in from the Keychain's
  refresh token (the mock counts a refresh and no new code), expired tokens
  refresh, an ended SSO session shows "Sign in again", signing in again
  connects, the mock's own instance link opens its artifact, another
  installation's or an instance-less link is refused, and scanning the
  code again from Settings shows the server and adds nothing.
- `testDiscoveryAnsweredByTheEdgeOnADevice` runs on a phone with
  `TEST_RUNNER_HAPPY_EDGE_DEVICE=1`: a scanned code for a plain website answering
  `/v0/authentication` is refused with the administrator's fix.
