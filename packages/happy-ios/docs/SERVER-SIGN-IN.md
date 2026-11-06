# Team servers behind SSO

A team runs Happy Agent on its own server, behind an HTTPS load balancer
that may enforce the organization's single sign-on. The app adds such a
server only by scanning the code Happy Desktop shows, and signs in with
the server's own OAuth method. It never takes a typed or pasted address.
The one exception is Happy Cloud, whose address is compiled into the app
(below). It
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

## Happy Cloud

Happy Cloud has one account service, `https://auth.happy.engineering/`,
and any number of servers, each a team server at `https://<name>.<base>/`.
Both are compiled into the app (`HappyCloud.accounts`, `HappyCloud.base`,
`Sources/HappyCore/ServerSignIn/HappyCloud.swift`) and can't be edited.
The contract shared with Android, desktop and the backend is Happy Cloud
accounts and servers v1, with v4's token lifetimes.

- **Where.** "Connect to Happy Cloud" in the account switcher's menu (the
  list of accounts and servers, under Add) and in the scanner's and first
  screen's ⋯ (`AccountAdding.connectToCloud`). Development and preview
  builds only (`HappyCloud.isOffered`, from `AppVariant`): production shows
  neither entry and `connectToCloud` does nothing there.
- **Screens.** Every Happy Cloud step is a full-screen page in the
  onboarding's look (`CloudStageViewController`: the grain gradient, large
  title, one primary button at the bottom, no tables or alerts): Welcome,
  Your Servers, Name Your Server, Join a Server, Connecting. With no
  account yet it's pushed on the first screen; otherwise it's presented
  full screen with a Close button.
- **Welcome.** "Connect to Happy Cloud?" ("Sign in or create an account
  to add a cloud team. Agents run in the cloud; no computer needed.") with
  Sign in with Apple's own button as the primary action and Other Ways to
  Sign In under it. While the account's pass lasts, the flow opens on Your
  Servers instead.
- **Account sign-in** (`CloudAccount`). Either way it ends in a pass: an
  account token whose `aud` must be the accounts origin, good for an hour,
  with no refresh token.
  - *Sign in with Apple* (`CloudApple`): `ASAuthorizationAppleIDProvider`
    asking for the name and email, its `nonce` the SHA-256 of a fresh
    random one. `POST /v1/auth/native` gets `provider` `apple`, the
    identity token, the raw nonce, the authorization code and, when Apple
    gives it (the first time only), the person's full name. The
    `com.apple.developer.applesignin` entitlement is on the development
    and preview apps.
  - *Other ways*: authorization code + PKCE S256 at
    `auth.happy.engineering/authorize`, `client_id` `happy`, the usual
    redirect, and `resource` the accounts origin, in
    `ASWebAuthenticationSession` with
    `prefersEphemeralWebBrowserSession = false`. A refresh token, if one
    came, is dropped.
  - *A test account* (`CloudTestSignIn`), for testing every surface without
    Apple or GitHub: ten taps on Welcome's logo within four seconds make a
    login and password form, which isn't there before. `POST
    /v1/auth/password` with `{ login, password }` answers the same pass;
    401 `invalid_credentials` and 429 `locked` (`retryAfter` seconds) are
    said under it. The password is only in its secure field and that
    request, cleared once signed in. Development and preview builds only,
    as Happy Cloud is. Operators make these accounts; see the cloud's
    TESTAUTH.md.
  - The pass is held in memory only, with its expiry, and never refreshed.
    Opening the flow after it ends, a minute early, or a 401 from any
    accounts call goes straight back to Welcome, with no retry. Earlier
    builds' Keychain item (`happy-ios:cloud-account`) is deleted.
- **The picker** (`CloudServersViewController`). Your servers
  (`GET /v1/servers`) as cards; Create a New Server opens Name Your Server
  (a name under `.<base>`, checked as it's typed with
  `GET /v1/servers/availability`, then `POST /v1/servers`); Join with an
  Invite opens Join a Server (name and invite code,
  `POST /v1/servers/join`). A server already connected is switched to.
  Each row is titled with the server's `displayName` (its node name), with
  `@name` under it, and shows its picture: the ThumbHash at once,
  then the bytes from the listed image `url` under the account token (only
  ever on the accounts origin), or the generated avatar seeded by the
  server's id when it has none.
- **Connecting** asks the accounts service for the server's own tokens,
  `POST /v1/servers/:id/token` under the pass: no browser. The access
  token's `aud` must be `https://<name>.<base>/`, built from the listed
  name and the app's own base, never from the listed `url`. Its refresh
  token is the lasting session, kept as any server's below and refreshed
  at `auth.happy.engineering/token` (`refresh_token` grant, `client_id`
  `happy`, `resource` the server) without the account. Then, as after any
  sign-in, the server is asked who signed in, its installation is
  recorded, and the connection is added. The account token goes only to
  the accounts service.
- **Sign-in methods.** Apple natively and GitHub on the browser page
  (Other Ways); no Google or email anywhere in the app.
- **Sign Out of Happy Cloud**, in the account switcher's menu while the
  pass is held, forgets the pass. The servers stay connected.
- **Removing a cloud server** drops it on the phone and revokes its
  session at the accounts service: `POST /revoke` (RFC 7009) with its
  refresh token and `client_id`, best effort
  (`AgentConnections.revokeIfCloud`).
- **No scanned code.** The scan-only rule exists so that no one can send a
  person's sign-in to a server by a link or a pasted address. Cloud
  addresses come from the app's base, so the rule doesn't apply to them,
  and only to them: `HappyScan` still refuses every other server not
  scanned.
- **Installation.** There is no code to compare with. After the tokens
  come, health's `instanceId` is read and kept on the connection as
  reported (`ServerSignInFlow.Installation.recorded`); a server reporting
  none still signs in. "Sign In Again" then checks the one kept, as for
  any server.
- The connection is named after the server until `/v0/config` names it.
- **Display.** A cloud server's address is never shown: it reads like a
  username, `@acme` (`HappyCloud.handle`), in the picker, the create field
  (an `@` in front, no domain), the availability and join messages, the
  sign-in screen and Settings. The domain isn't final; the URL is used
  internally as before.
- Same-origin and audience binding apply unchanged: a server's token must
  name its address.

## Sign-in

A fresh install needs nothing else first: no paired computer, Happy
account or Happy Cloud sign-in. The first screen's Start opens the scanner,
and a server code scanned there signs in and lands on the server's home.

1. The server comes from a scanned code, Happy Cloud's picker, or the
   connection signing in again.
2. `GET /v0/authentication` (`ServerDiscovery`) runs without a token and
   doesn't follow redirects. A redirect (3xx but not 304), a 401 or a non-JSON 403 here means the
   load balancer didn't let discovery through, and the screen says so.
   Methods of a type the app doesn't know, or with insecure URLs, are left
   out. This runs as the sign-in screen opens, which then shows the
   server's host and, beside it, the host the person will sign in at
   ("Sign In At"). The method discovered then is the one used.
3. The method must be bound to its authorization server (below), and the
   attempt freezes it: the token URL, refresh URL, client ID, resource and
   the server URL from the code are kept in memory
   (`OAuthSignInRequest`) and never read from the server again, at the
   callback or at any refresh.
4. `ASWebAuthenticationSession` opens `authorizationUrl` with
   `response_type=code`, `client_id`, `redirect_uri`, `state`, an S256 PKCE
   challenge, `scope`, and `resource` (RFC 8707) when discovery gives one.
   The session isn't ephemeral, so the organization's SSO cookie in Safari
   is reused.
5. The code goes to `tokenUrl` as a form (`OAuthTokenClient`, through
   `NoRedirectURLSessionTransport`, which refuses redirects), with
   `resource` when present. The access token must name this server
   (below).
6. `GET /v0/authentication` with the new token confirms
   `authenticated: true`, and health is checked against the code's
   `instanceId` (above). When `userId` is null, the server hasn't met this
   person yet: the app asks for a name and saves it with
   `PATCH /v0/profile` before keeping the account. Otherwise the team-mode
   profile gate would answer 401 to everything.
7. `AccountController.addServer` keeps it as an agent connection
   (`AgentConnection.server` is the origin) and opens it.

## Binding a sign-in

API.md ("Binding a sign-in", edge SSO contract) closes two ways a
malicious server, such as one a scanned code points to, could take a
sign-in:

- **Same origin.** It could advertise the real identity provider's page
  with its own token URL, and so receive the code and the PKCE verifier.
  Before the browser opens, `OAuthMethod.isBoundToItsAuthorizationServer`
  requires `tokenUrl`, and `refreshUrl` when there is one, to have the
  origin of `authorizationUrl`. Origins are compared parsed
  (`OAuthOrigin`: lowercased scheme and host, the port or the scheme's
  default), never as string prefixes. A host spelled in Unicode on one
  side and punycode on the other doesn't match, which refuses rather than
  guesses. Otherwise: "This server's sign-in settings would send your
  sign-in to a different site, so they can't be used."
  (`OAuthError.crossOrigin`).
- **Audience.** It could copy the real deployment's method, so the person
  signs in for real and the app hands it a genuine token. After the code
  exchange and after every refresh, the access token's JWT payload is
  decoded (the signature isn't checked; the server does that) and its
  `aud`, a string or an array, must hold an absolute URL with the server
  URL's origin and path, a missing trailing `/` added (`OAuthAudience`).
  The server URL is the code's base URL, kept in the grant as `audience`.
  A token that doesn't match, or isn't a JWT, is dropped with its refresh
  token before either is stored or sent: "This sign-in is for a different
  server." (`OAuthError.wrongAudience`), and a refresh that gets one ends
  the sign-in. Deployments must set `[feature.team.jwt] audience` to their
  public base URL. A grant saved before this was added takes its
  connection's server as its audience.
- Token requests never follow redirects
  (`NoRedirectURLSessionTransport`: `willPerformHTTPRedirection` answers
  nil).

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
checked after sign-in, the same-origin rule, the audience check at the
exchange and at refresh, refresh-and-retry, a single shared refresh, the WebSocket handshake and
framing, and tunnel classification.

`scripts/edge-sso-mock/server.mjs` plays the load balancer, the identity
provider and the daemon in one Node process: HTTPS on 8443 (certificates
from `certs.sh`) and the same on plain HTTP on 8444. Without a valid
bearer everything but discovery is a `302` to the IdP, CONNECT is a `405`
HTML page, and `/control/expire`, `/control/revoke` and `/control/restore`
expire every access token, end the SSO session, or let it sign in again.
Access tokens are unsigned JWTs for `https://localhost:8443/`;
`/control/audience?aud=…` mints them for another server and
`/control/split` advertises a token URL on another site (`/control/bind`
undoes it).
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
  refused before any request, the code opened as a link is refused, a
  method whose token URL is another site is refused before the browser, a
  token for another server is dropped after it, a code
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
