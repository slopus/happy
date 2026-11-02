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

`AgentHTTPTransport` (still also named `TailcatHTTPTransport`) keeps several
Tailcat clients for each instance (`TailcatClients`), picked by each
request's `RequestCategory`: one for
`.realtime` (the event stream), one for `.query` (ordinary API calls, the
default) and up to eight for `.file` (pictures and avatars, attachments,
messages with images, tool-call media, artifact files, and the in-app
browser's streams). Each is made on first use with a node key of its own,
fresh on every connect: the computer and the DERP relay tell clients apart by
node key, and a relay keeps one connection per key. A file request goes to
the file client with the fewest requests in flight, and another is made only
while every one is busy. A query has 35 seconds, a file 15 minutes. A
failure resets only the client it happened on, so a broken file client never
drops the event stream; the event stream's silence watchdog resets only
`.realtime`. Every client's tunnel reports to the same `ConnectionMetrics`.
Over HTTPS (a computer with a public URL) there are no clients; each flow is
its own TLS connection, still tagged with its category, so a reset closes
only that category's, and the deadlines are the same. `AgentEndpointTransport`
passes the category on to whichever transport it has picked.
Each request opens a fresh TCP stream, mapping the logical `server.tailcat`
authority to `openTCP(port:)`. Responses support content length, chunking
and EOF, with bounded bodies, metadata and request deadlines. Cancellation
closes the request stream; instance teardown closes every client.

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
relaunch. Disconnecting takes the agent off the list and out of the open
slot at once (`AgentConnections.forget`): its identity loop and engine can
no longer publish or save anything of it, so nothing waits for them.
`finishRemoval` then erases the credentials and cached identity, gives the
engine up to 10 s to close its database (one stuck on the network doesn't
hold the rest back), and deletes the folder off the main thread.

Device tokens cannot access connector management routes. Disconnect therefore
forgets this phone's credentials locally; desktop device management handles
server-side revocation. There is no invented phone revocation endpoint.

The combined home switcher lists both account kinds. A single account keeps
the app logo; multiple accounts show the current avatar. Selecting a direct
computer stops the legacy active session. Its `DirectSyncEngine` owns the
account's desktop snapshot, events, conversation checkpoints and durable
message outbox. Direct accounts never create a LocalStore, HappyAPI,
socket.io connection or relay SyncEngine.

The direct composer accepts images, videos and documents up to 50 MiB per
file. Picker copies become queue-owned files under the account's Application
Support directory before the draft clears. Every attachment, images
included, uses the authenticated workspace file PUT over Tailcat, so it
lands on the agent's own disk wherever that computer is. The message then
names the files in the note every Happy client uses (happy-cli's
`formatAttachmentNote`: "The user attached 1 image. It was saved on this
machine and not loaded into your context; …" and one `- ./.happy-uploads/…`
line per file), and the agent opens only what it needs; nothing goes to
`/send` as an image block. Outbox rows from older versions that still hold
inline pictures are moved to files before delivery
(`AttachmentRules.migratePictures`). Until the computer has the message the
bubble draws the pictures from the phone's copies; after that it shows the
message's text. The agent response supplies the execution workspace ID,
which is persisted before the first upload. Stable message paths,
create-only writes and SHA-256 matching make a lost acknowledgement safe to
retry. Per-file upload progress is saved before the message is sent with
relative file paths.

An upload can take up to 15 minutes and writes its request body in cancellable
chunks. Acknowledging the outbox row retains local copies: an older cached
conversation may still need them after a crash. Only a successful serialized
conversation checkpoint containing the daemon's echoed message removes its
copies. A newer conversation instance owns that resource's cache; SQLite
checks ownership in the same actor operation as the write, so a late flush
from an older screen cannot restore deleted attachment references. Skipping
an older screen's cache write still requires its send to reach the durable
account outbox before the composer clears. Forgetting the account removes
its entire offline directory.

Tests pin the API's independent cryptographic vectors and emoji table hash,
wire routing, HTTP framing, handshake outcomes, identity/ETag updates,
Keychain isolation/removal, mixed selection/restoration, revocation and measured
UIKit layouts. Native interoperability and release evidence are recorded in
the release report rather than inferred from these unit tests.