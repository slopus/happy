# Direct computers

The camera and deep-link entry point classify `happy://direct?` before the
existing terminal/device-link parser. `DirectPairingLink` validates the
canonical base64url JSON, version, token, port, display name and expiry.
Malformed direct codes never fall back to relay approval.

`DirectPairingService` implements the mobile connector contract in Happy
Agent's API.md: X25519 commit/reveal, four locally derived emoji, confirmation
on both screens, and constant-time daemon MAC validation. The QR name is
labelled unverified. No credentials are stored until the final proof checks.
The authenticated node name and avatar are fetched before the paired account
is activated when reachable; otherwise its initial name is “Happy Agent”.

`TailcatHTTPTransport` retains a Tailcat client for each instance and opens a
fresh TCP stream per request, mapping the logical `server.tailcat` authority
to `openTCP(port:)`. Responses support content length, chunking and EOF,
with bounded bodies, metadata and request deadlines. Cancellation closes the
request stream; instance teardown closes the client.

Direct credentials use the existing `AccountKeychainBackend` under their own
`happy-ios:direct-device` service. They contain the secret Tailcat address,
port, device ID and device token. `direct-accounts.json` contains only cached
identity, avatar, selection and revocation state. Keychain enumeration recovers
entries after metadata corruption; Keychain access errors preserve them.
The legacy registry and RN-compatible shared item keep their current format.

`DirectAccounts` connects each stored instance independently on launch and
foreground. It checks health and refreshes `config.node` every minute, using
`GET /v0/node/avatar` with `If-None-Match` even when ThumbHash is unchanged.
Transient failures reconnect with 1–30 second backoff. Background cancels and
awaits the loops; 401/403 marks the device revoked and prevents retries across
relaunch. Removal awaits teardown before erasing credentials and cached
identity, so a stale request cannot recreate a removed account.

Device tokens cannot access connector management routes. Disconnect therefore
forgets this phone's credentials locally; desktop device management handles
server-side revocation. There is no invented phone revocation endpoint.

The combined home switcher lists both account kinds. A single account keeps
the app logo; multiple accounts show the current avatar. Selecting a direct
computer stops the legacy active session and shows connection status and
“Sessions and messages are coming soon.” Direct accounts never create a
LocalStore, HappyAPI, socket.io connection or SyncEngine. Their only ordinary
API calls are health, config and avatar reads.

Tests pin the API's independent cryptographic vectors and emoji table hash,
wire routing, HTTP framing, handshake outcomes, identity/ETag updates,
Keychain isolation/removal, mixed selection/restoration, revocation and measured
UIKit layouts. Native interoperability and release evidence are recorded in
the release report rather than inferred from these unit tests.