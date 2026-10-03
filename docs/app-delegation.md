# Application-scoped Paws chat authorization

First registered application: relationship-advisor (`https://advisor.paws.rodeo`).
Base revision: `58a563bf0cdc0a7d79c9c29f711b99322b85ec6e`.

## User flow

The advisor retains its invitation/host service and adds “我的 Paws”. It creates an
application authorization QR, not an account-login QR. Paws asks the owner to
choose one compatible online machine and a 1-day, 7-day, or permanent lifetime. Settings →
已授权应用 lists connections and revokes them. No recovery code is requested by
the advisor. Existing Paws login/recovery remains inside Paws itself.

The SDK exports `startBrowserAppAuthorization` and `createDelegatedChat` from
`@wangjs-jacky/paws-agent/browser`. This pilot deliberately registers only the
advisor application and the `codex:chat` scope; adding MISS requires registering
its own identity and reviewed execution policy.

## Security contract

- A random 256-bit pairing proof is exchanged for a separate random credential.
  The server stores hashes, not bearer secrets. A lost redeem response can only
  be retried with the same credential. Requests expire after ten minutes.
- The approving Paws client generates a fresh grant key. It seals a context-bound
  envelope to the requesting browser and encrypts a separate envelope for the
  selected machine. Neither root account credentials nor machine encryption
  keys go to the application.
- Machine encryption currently uses the existing owner/credential-family key;
  it is not a cryptographically unique per-machine key. Exact machine ownership
  and job binding are also enforced by the server and worker.
- `paws_app.*` credentials are explicitly rejected by the shared normal REST and
  socket account verifier. They cannot invoke ordinary session or machine RPC.
- Authenticated payloads bind version, grant, conversation, turn, direction and
  sequence. Images must be bounded PNG/JPEG/WebP data URLs; paths and remote URLs
  are not accepted.
- All authority mutations, claims, output publications and revocation use the
  existing serializable transaction/retry wrapper. Random leases and increasing
  sequence numbers fence stale workers. An expired lease fails a turn and is
  never reassigned/replayed.
- Revocation immediately rejects subsequent data-plane operations and clears
  running leases. Workers check every three seconds with a seven-second network
  deadline and abort on failure or socket loss. Already delivered content or
  submitted provider work cannot be recalled.
- Each job starts a separate Codex process in an empty HOME/cwd and isolated
  CODEX_HOME. Only the selected Codex account auth is provisioned. Host config,
  skills, plugins, MCP servers and history are not inherited. Tool features and
  environments are disabled; any tool/approval request is rejected. Only the
  verified Codex 0.159.3 runtime is advertised. `HAPPY_CODEX_PATH` can select an
  absolute installed executable. Other versions stay unavailable until tested.
- An explicit managed Codex account binding is required. The consent page explains
  how to bind it in Device Environment; unbound machines are not advertised.
  Refreshed credentials use existing launch/version attribution and an independent
  cleanup timeout. Failed refresh saves retain a private checkpoint/home and are
  retried before the worker accepts another job; no refreshed auth is discarded.
  A kernel-owned loopback listener serializes recovery/execution for a machine.
  Live/unknown old daemon or runtime PIDs retain the directory and block new jobs;
  port collisions also fail closed. A diagnostic is emitted without credentials.
  Local login files are never copied or overwritten by this delegated worker.
  Failures never switch to the advisor's host account.
- Public pairing has bounded per-IP limits and small body limits. Each grant has
  a 100 MiB ciphertext budget, 100 conversations, and 100 turns/conversation;
  accounts have at most 20 active grants and 100 retained grants. Expired or
  revoked grants retain their conversation history until the owner deletes the
  connection and its history. Pairing cleanup only removes expired pending
  requests and expired, unredeemed approvals without conversations. History is paginated one turn at a time;
  live polling reads only one turn's current output. Deleting a conversation
  releases its storage budget and fences its running worker.
- The advisor keeps only the scoped credential and grant key in sessionStorage.
  Clearing local storage is distinguished from server-side revocation. Source
  switches clear local drafts/history and cannot occur during submission.

Public-client QR forwarding/phishing remains possible: users must only approve
requests they initiated at the displayed origin. CORS is not application identity
proof. The consent page explicitly warns against other people's authorization QR.

## Permanent grants and the owner directory

Permanent access is an explicit `expiresAt: null`, bound into both encrypted
envelopes. Missing or malformed expiry remains invalid. QR proof redemption
still expires after ten minutes; that deadline does not expire an already
redeemed grant. Revocation and per-turn process/lease cleanup are unchanged.

New SDK requests advertise protocol 2. Their pending state is `pending-v2`, so
older SDK requests never silently receive a null expiry they cannot consume.
Permanent consent also requires a protocol-2 worker. Protocol-1 workers can
continue finite grants but cannot claim permanent jobs. No schema migration is
needed. Roll out the server, then CLI and Paws UI, then the rebuilt advisor SDK.
Existing grants keep their original lifetime; permanent access requires a new
authorization. The advisor still stores its credential in the current tab's
sessionStorage; permanent authority does not change that storage policy.

The new Applications sidebar entry changes only the middle list, preserving the
current right-hand route. Conversations are grouped by application. Its menu
opens the registered application, revokes a connection, or explicitly deletes
that connection and its history. The owner directory exposes only identifiers,
device association, dates and status, with 50-item cursor pages; it does not
return ciphertext, tokens or envelopes, and it adds no conversation reader.
Titles use creation dates because original content remains encrypted. Polling
stops when the sidebar is hidden or the app enters the background.

## Initial delegation release validation

Automated tests use real PGlite transactions and the generated SQL migration,
plus SDK crypto replay tests and Fastify request-size/origin/rate-limit tests.
A separate test proves app tokens cannot enter the account verifier.

Browser acceptance uses Ego task space 377, a new test identity and local-only
servers (Paws API 3039, Paws UI 8089, advisor 4199). No production account was
imported or authorized. A copy of the local Codex subscription credential was
provisioned only in the private isolated local test database for managed-account
text/image checks, and is removed after testing.

| Case | User-visible outcome | Result |
| --- | --- | --- |
| Connect | Advisor QR → choose machine/lifetime in Paws → connected | pass |
| Chat | Real relationship response on selected test machine | pass |
| Refresh | Same source and encrypted conversation restored | pass |
| Stop | Generation cancelled and composer usable | pass |
| Revoke | Paws shows revoked; app requests denied, no host fallback | pass |
| Images/reconnect | Reconnect and image message | pass (managed account text + image rechecked) |
| Isolation | Cross-grant, replay, expired lease, concurrent revoke/claim | pass |
| Delivery | PR/CI, production deployment, CLI rollout | pending |

Happy key-step screenshots were reported with session-bound receipts. Native
phone camera scanning has not been verified; the browser approval link exercises
the same consent page and protocol. A 15.85-second H.264 390×844 Ego screencast of
final first-send controls, real response and refresh restoration was fully decoded
and sent through Happy. Playback on the user's device is not yet confirmed; this
clip is not a video matrix for every case. Cancel/reopen QR was separately checked
to clear old QR/link/status; a fresh request was approved and connected.

Local validation totals: server delegation 11, managed account routes 33, SDK 350,
CLI lock/credential lifecycle 24, app OTA contract 7, advisor 5 tests passed.
Independent security review passed; static interaction findings were fixed and
the affected browser steps rerun. CLI, server, SDK and app typechecks passed.

The Expo dev typed-route generator included colocated test files and produced
an empty route union. For local typecheck, regenerate with a requireContext that
excludes `.test`/`.spec` route files; no production route code was altered for
this pre-existing tooling issue.

## Rollout

1. Review/merge through the normal Paws PR workflow. Apply the additive generated
   migration; old clients are unaffected by the new tables.
2. Verify the merge's Web and OTA workflows. New UI on an old server fails closed.
3. Roll out CLI 1.3.18 and restart through the supported daemon wrapper. A machine
   appears in consent only after a compatible restricted worker advertises itself.
4. Build SDK 0.3.0 and the advisor bundle from this reviewed checkout using
   `PAWS_WORKSPACE=/path/to/happy node scripts/build-paws-sdk.mjs` in the advisor
   repository. Release the advisor atomically only after the server/worker exists.
5. Verify an actual user-initiated connection on the production origin. Do not
   substitute a temporary public preview for the required Paws production origin.

## Directory and permanent-access acceptance (2026-10-03)

Base revision: `459a49941d4ddd89a196c6e73acec4faf661c9d9`. Ego task space 420
used an isolated account and PGlite database, with no real provider credential
or model execution. The full Paws UI ran at 1440×960 in ginghamDark; consent was
also exercised at 390×844. This was a mobile-width Web check, not an Android APK
or physical-camera test.

- Navigation changes only the middle list; URL and unsent right-side draft stay
  unchanged. Application groups show completed, expired and revoked history.
- Enter opens the menu within the viewport; Escape closes it and restores focus.
  Its final connection action remains reachable by internal scrolling.
- Protocol-2 SDK request → select device and permanent lifetime → UI approval →
  SDK envelope decryption → create application conversation passed against the
  real isolated API. The returned expiry is explicitly null.
- Revoking that permanent connection returns HTTP 403 to its SDK credential,
  while retaining the directory row. Explicit deletion removes only that
  connection and its conversations; the other three fixture rows stay intact.
- Independent code review passed. Server delegation/routes (14), SDK delegation
  (12), App sidebar/API/QR/OTA contracts (66), and advisor (5) tests passed.
  CLI, server, SDK and App typechecks passed; the existing generated-route issue
  above required regenerating `.expo/types/router.d.ts` from non-test routes.

The [PC state demonstration](assets/app-conversations-states.mp4) is a sequence
of verified list/menu/revoked/deleted frames, not a continuous screen recording.
It is H.264, 1440×960, yuv420p, fully decoded successfully, and was sent through
Happy. User-device playback has not been confirmed. PR before/after screenshots
were asked about but not requested; no before/after matrix was collected.

These results do not claim production rollout. The companion advisor bundle
must be rebuilt from the same reviewed SDK before enabling permanent requests.
