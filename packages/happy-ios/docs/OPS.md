# Native operations

`AccountSession.actions` exposes session RPC controls and files;
`machineActions` exposes machine RPC, spawn, resume, fork and rewind;
`gitStatus` shares git snapshots by machine and checkout path; `pendingChats`
holds starts in flight and their writing within this account.

`SessionActions.ensureSessionReady(sessionId:)` waits for metadata and both keys
before a newly spawned session takes text or a picture. It makes at most three
sessions-sync rounds, each capped at four seconds, with 300/600ms backoff.
Cancelling a timed-out waiter leaves the shared sessions job running.
`uploadSessionBlob(sessionId:name:bytes:)` shares the outbox's blob encryption
and attachment API: the upload request counts sealed bytes, while the returned
size counts plaintext bytes. Both methods also exist on `SyncEngine`.

The wire source is happy-app's `sync/ops.ts`, with CLI handlers in
`modules/common/registerCommonHandlers.ts`, `api/apiMachine.ts`, and the
Claude/Codex launchers. RPC parameters and replies use the addressed record's
data key. Resume fallback sends the session data key only to the machine named
in that session's metadata; an absent or legacy key is never replaced with the
account secret.

Session metadata writes retain unknown fields and retry version conflicts at
most three times. Mode picks are optimistic in `composerState`. Each account's
sync engine counts pending pushes per session and field; inbound metadata
cannot replace a pending pick. Otherwise an explicit metadata value wins,
including null, while an absent key retains the local value. The store writes
the session and reconciled composer in one transaction. Rig v1 instead writes
its complete draft under a monotonic `draftUpdatedAt` stamp and adopts a remote
draft whose stamp is equal or newer. The session, draft text, and picks commit
together. A clear echo retains the picks used by the send until `lastMode`
changes. `AccountSession.rigComposer` owns one writer per session, coalesces
edits during a write, debounces typing for 250ms, and writes empty text or mode
changes immediately. Connected failures retry from 1s up to 30s; reconnect and
foreground flush locally newer persisted drafts. `OutboxSender` routes drafts
and successful-send clears internally, preserving writing begun during send.

`SessionActions.supportsHappyAgentGit(_:)` checks Rig v1, readable files and
the full native Git RPC surface. `getHappyAgentGitState(sessionId:)` validates
the native `gitState` snapshot and preserves unknown schema fields.
`readHappyAgentGitFile(sessionId:gitBase:file:)` reads base and working-tree
sides concurrently with strict base64 and UTF-8 checks, retaining BOM changes,
a 512 KiB per-side limit, and a 20,000 combined-line limit. Unsupported changes
return the exact source messages; image comparisons use each side's MIME type.
Shell GitStatusSync remains the source-compatible status path for CLI sessions.

Git observers emit a cached snapshot immediately. A screen calls
`refresh(sessionId:)` on opening; account socket updates subsequently invalidate
observed checkouts, with a 300ms debounce. Transport failures retain a previous
snapshot; a failed git repository check clears it. Porcelain v2 rename paths
follow Git's actual destination-then-source order. This corrects happy-app's
parser, which currently reverses those two fields. Staged and unstaged numstat
remain independent, binary changes have zero line counts, and C-quoted UTF-8
paths are decoded.

Current happy-app has no session rename flow and does not use its remaining
`recentMachinePaths` settings key. Native adds neither flow and keeps that
settings key round-tripping. The path picker reads `SessionPlaces` from sessions
on both paired daemons, offering catalog-only projects by identity and excluding
archived workspaces and bots.

## Push composition

The Happy server sends through Expo. `ExpoPushTokenExchange` converts APNs bytes
to a server-compatible Expo token over `HTTPTransport`; the exchange receives
no Happy account credentials. `TokenPushRegistration` then registers that Expo
token with the signed-in `HappyAPI`, persists it, and removes a differing old
token without failing the new registration if old-token cleanup fails.
`removePushToken(api:token:)` unregisters a token and clears the account cache
only when it matches that token. `pushTokens()` already lists registrations;
`unregisterPushToken(_:)` checks the unregister acknowledgement.

CompositionRoot must supply:

- Notification permission, `UIApplication.registerForRemoteNotifications()`,
  and AppDelegate's success/failure token callbacks. The injected `deviceToken`
  closure supplies callback bytes, or nil when none is available.
- The running bundle identifier as `Configuration.appId`.
- The actual APNs `aps-environment` entitlement as `development`: true only
  for `development`, false for `production` or an unavailable environment.
  Debug configuration is not an APNs environment.
- The persistent installation UUID as `deviceId`. Expo uses generic-password
  Keychain service equal to the bundle identifier, with account and generic
  both the UTF-8 bytes of `EXDeviceInstallationUUIDKey`, and accessibility
  `AfterFirstUnlockThisDeviceOnly`. Read that existing item first; otherwise
  migrate the same legacy standard UserDefaults key, deleting it only after a
  successful Keychain save; otherwise create and persist a UUID. The exchange
  lowercases it on the wire.
- Project id `4558dd3d-cd5a-47cd-bad9-e591a241cc06`, exposed as
  `ExpoPushTokenExchange.happyProjectId` (from happy-app's EAS configuration).
- The active account's `LocalSettings` as `PushRegistrationTokenCache`, storing
  `registered-push-token-v1` in `happy-ios.local-settings.<id>` and clearing it
  on sign-out. Use `TokenPushRegistration(source:cache:)` to preserve Settings'
  current-device identity across relaunch, then register against that account's
  API when APNs provides a token and when the active account changes.

`Sources/HappyApp/PushNotifications.swift` supplies all of the above. It
uses `ExpoDevicePushTokenSource`, `ExpoInstallationID`, `ProvisioningProfile`,
`APNsTokenSource` and `PushTokenSync`; AGENTS.md, "Push notifications",
describes the behaviour.

Linux tests pin the exchange body and nested response, authenticated push API,
encrypted RPC scopes and payloads, mode conflict handling and atomic observation,
git parsing, and ordered pending-chat handover. Device notification delivery,
real daemon interoperability, and UIKit behavior still require a device run.
