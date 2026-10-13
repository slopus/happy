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
`ServerConfig`: importing RN's MMKV custom-server preference is not implemented.

`Happy/accounts.json` contains only id, URL, item location, added order, and
active id. Atomic writes prevent partial JSON. Recovery imports unknown
items, drops entries without credentials, and preserves credentials on
Keychain access errors. Corruption loses the previous active selection and
added order; recovered accounts receive a deterministic order by id.

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

Caches live in `Happy/accounts/<id>/store.sqlite` and `files/`. The previous
`Happy/happy-<id>.sqlite` migrates by moving WAL/SHM first, then the database.
The database move is the completion marker; an interrupted migration resumes
the remaining moves. Per-account local defaults use
`happy-ios.local-settings.<id>` and are cleared only when that account leaves.

Linux tests cover the rollback matrix, item updates, missing/corrupt registry,
locked Keychain, separate caches/settings/servers, active-account restore,
socket shutdown, SQLite migration, interrupted sidecar migration, cancellation,
and failed secondary deletion. Device Keychain behavior and an actual upgrade
or rollback between RN/native builds still require an iPhone.