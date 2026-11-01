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
deleting its directory; lingering store references then read empty data
(see "Signing out and disconnecting").

Push notifications register only the active account, caching its token in
that account's local settings. Switching never unregisters, so every
signed-in account keeps notifying. Signing out removes the account's cached
token from the account's own server, using its own credentials, and never
sends anything to an unconfirmed server; but the sign-out never waits for
it (see below).

`accountHoldingSession(_:)` finds which account a tapped notification
belongs to. It checks the active store first, then the other confirmed
accounts in added order. Inactive stores are opened with GRDB's read-only
configuration, as profile recovery does.

Linux tests cover the rollback matrix, item updates, missing/corrupt registry,
locked Keychain, separate caches/settings/servers, active-account restore,
socket shutdown, SQLite migration, interrupted sidecar migration, cancellation,
failed secondary deletion (still signed out, finished at the next launch)
and a kill straight after a sign-out (`InstantSignOutTests`). Additional fixtures cover MMKV record override,
deletion, nested string lengths, metadata/header disagreement, CRC failures,
default/custom host selection, and zero HTTP/socket activity before manual
confirmation. Profile updates, multiple observers, duplicate-item removal and
retained-store cleanup are also tested. Device Keychain behavior, real-device
MMKV path and decoding, and an actual upgrade or rollback between RN/native
builds still require an iPhone.

## Signing out and disconnecting

Both are instant and final. Settings asks first (a Happy account's secret
key warning, an account made for a computer's "nothing can open it again");
from the confirm on, `beginSignOut(accountID:)` does in the same call:

1. writes `{ id, kind, Keychain location, confirmed server }` to
   `Happy/removals.json` (`AccountRemovalJournal`, a few hundred bytes,
   the one write on the main thread);
2. takes the account out of the registry in memory (or, for an agent,
   `AgentConnections.forget`) and tells the observers, so it leaves the
   switcher and the accounts card;
3. if it was the one open, opens the next: another agent at once; the
   next Happy account by added order once its store is open, off the main
   thread, a few milliseconds; an agent where computers are a home of their
   own; or nothing, the first screen.

It returns the cleanup, which nothing on screen waits for:

- the registry written without it;
- for a Happy account, the push token's removal handed to
  `PushUnregisterQueue` with what it needs (server, bearer token, push
  token) in its own Keychain item, `happy-ios:push-unregister`, before the
  account's credentials go. It is sent at once and, until the server
  answers (2xx, or a 4xx other than 408 and 429), again at 1, 2, 4 … 30 s
  and at each launch, for up to 30 days;
- the account's Keychain item (the RN item's three entries for the shared
  account, only if it still holds that account);
- the old session stopped, socket and sync included, waited for at most
  10 s, then its store erased and closed (a closed store refuses whatever a
  stuck request would still write), pictures closed, folder and device
  settings deleted;
- for an agent: credentials and cached identity, then up to 10 s for its
  engine to close `direct.sqlite`, then its folder (media included);
- the journal entry struck off, only once all of it went.

Ids in the journal are never listed again: `reconcile` drops them even
while their Keychain items are still there, a stale registry assignment is
stripped of them (`registry` `didSet`), and `AgentConnections` hides them
at restore. At launch, `prepareStorageDirectory` reads the journal before
anything is listed and finishes what a kill left. Signing the same account
in again waits for its cleanup, then keeps it.

Before this, a Happy account's sign-out awaited the push token's removal (up
to 5 s, the whole time on a network that never answers), the session's stop
and the Keychain, and only then changed the root; an agent's disconnect
deleted its offline folder on the main thread (140 ms with a 1500-file media
cache in the simulator), and the last account's Start screen compiled its
Metal shader on the main thread (precompiled during the confirm now).
`HostedInstantSignOutTests` measures confirm to the next home: the first frame
drawn after the button shows it (9-36 ms in a Debug simulator), against 5.0 s
for a Happy account before.
