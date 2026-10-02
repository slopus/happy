# Application-scoped Paws chat authorization

First registered application: relationship-advisor (`https://advisor.paws.rodeo`).
Base revision: `58a563bf0cdc0a7d79c9c29f711b99322b85ec6e`.

## User flow

The advisor retains its invitation/host service and adds “我的 Paws”. It creates an
application authorization QR, not an account-login QR. Paws asks the owner to
choose one compatible online machine and a 1-day or 7-day lifetime. Settings →
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
  accounts have at most 20 retained grants. Expired grants are removed after
  seven days during pairing cleanup. History is paginated one turn at a time;
  live polling reads only one turn's current output. Deleting a conversation
  releases its storage budget and fences its running worker.
- The advisor keeps only the scoped credential and grant key in sessionStorage.
  Clearing local storage is distinguished from server-side revocation. Source
  switches clear local drafts/history and cannot occur during submission.

Public-client QR forwarding/phishing remains possible: users must only approve
requests they initiated at the displayed origin. CORS is not application identity
proof. The consent page explicitly warns against other people's authorization QR.

## Validation

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
