# Native account storage

`AccountController` is the only session owner. `accounts` lists registry
entries; `switchAccount(to:)` opens the next cache before stopping the current
session, then publishes a new session identity before starting its sync.
Concurrent account transitions throw `operationInProgress`.

To add an account, call `beginAddingAccount()`, present onboarding, and use
`authService`/`signIn(_:)`. The active session keeps running until sign-in
succeeds. Cancel calls `cancelAddingAccount()`. `signIn` adds or updates one
account, activates it, and retains every other account. `signOut()` removes
the active account; `signOut(accountID:)` also supports inactive accounts.

Each server is pinned to its registry entry. While signed in, ordinary auth
uses the active server; onboarding/add-account auth uses `ServerConfig`.
Secondary Keychain items hold `{ credentials, serverURL }` to recover their
server after registry corruption. The shared item is always RN's exact
`{ token, secret }`. If its registry entry is lost, its server falls back to
the RN preference recovered from `<Documents>/mmkv/server-config` and its
`server-config.crc` sidecar. These unencrypted files are read only. MMKV's
metadata actual size takes precedence over the header, the reader verifies
CRC32, and later append-only records override/delete earlier ones. A missing
file/key or empty string uses the default server, never `ServerConfig`.

Undecodable files, missing checksums on nonempty data, and invalid URLs set
`serverConfirmed: false` in the registry. `pendingServerConfirmation` exposes
the selected account; the coordinator presents the existing server form as
the root. No session exists and no token goes to HTTP or a socket until
`confirmServer(_ url: URL, for id: AccountSummary.ID)` validates and persists
the choice. The form performs no network probe before confirmation.

`Happy/accounts.json` contains id, URL, confirmation status, item location,
added order, active id, and nonsecret profile display fields. Atomic writes
prevent partial JSON. Recovery imports unknown
items, drops entries without credentials, and preserves credentials on
Keychain access errors. Corruption loses the previous active selection and
added order; recovered accounts receive a deterministic order by id.
An id held in both the shared and secondary service retains its shared item;
the redundant own item is removed after a successful shared read.

Switcher names, usernames (the stored GitHub login), avatar URLs and thumbhashes
are cached from each store's `accountProfile` row. Recovery reads inactive
stores with GRDB's read-only configuration, avoiding migrations or live-state
resets. An observation of the active profile updates the cached fields.
`observeAccounts(_ handler: ([AccountSummary]) -> Void) -> AccountsObservation`
delivers a snapshot immediately and independent updates on inventory, active
account and profile changes. Release/cancel its token to stop delivery.
`localSettings` changes instance on switch; observers must read it again and
reapply the active theme.

The RN rollback matrix is executable in `AccountsTests` with a fake Keychain.
Each shared-item assertion compares exact bytes:

| Operation (shared A, secondary B) | RN item after operation | Native state |
| --- | --- | --- |
| Add B | A's original bytes | A and B retained; B active |
| Switch from B to A | A's original bytes | A active; B's socket/sync stopped |
| Sign out A while B is active | Absent | B stays active in its own item |
| Sign out B while B is active | A's original bytes | A becomes active |

Reauthenticating A updates only its shared item in RN's encoding.
Reauthenticating B updates only its own item, even after A signs out and the
shared slot becomes empty. A malformed occupied shared item is preserved;
adding an account uses a secondary item instead of overwriting those bytes.
Logout while signed out preserves every unknown/malformed shared byte. Only
explicitly signing out the identified shared account deletes the RN item.

Caches live in `Happy/accounts/<id>/store.sqlite` and `files/`. The previous
`Happy/happy-<id>.sqlite` migrates by moving WAL/SHM first, then the database.
The database move is the completion marker; an interrupted migration resumes
the remaining moves. Per-account local defaults use
`happy-ios.local-settings.<id>` and are cleared only when that account leaves.
Logout publishes the new navigation root before erasing the old store and
deleting its directory; lingering store references then read empty data.

Push notifications register only the active account, caching its token in
that account's local settings. Switching never unregisters, so every
signed-in account keeps notifying. `signOut(accountID:)` first removes the
account's cached token from the account's own server, using its own
credentials: one attempt, capped at 5 seconds, with any failure ignored and
nothing sent to an unconfirmed server. The settings are cleared afterwards.

`accountHoldingSession(_:)` finds which account a tapped notification
belongs to. It checks the active store first, then the other confirmed
accounts in added order. Inactive stores are opened with GRDB's read-only
configuration, as profile recovery does.

Linux tests cover the rollback matrix, item updates, missing/corrupt registry,
locked Keychain, separate caches/settings/servers, active-account restore,
socket shutdown, SQLite migration, interrupted sidecar migration, cancellation,
and failed secondary deletion. Additional fixtures cover MMKV record override,
deletion, nested string lengths, metadata/header disagreement, CRC failures,
default/custom host selection, and zero HTTP/socket activity before manual
confirmation. Profile updates, multiple observers, duplicate-item removal and
retained-store cleanup are also tested. Device Keychain behavior, real-device
MMKV path and decoding, and an actual upgrade or rollback between RN/native
builds still require an iPhone.
