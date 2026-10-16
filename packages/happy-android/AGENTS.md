# happy-android

Native Android client for Happy, in Kotlin. A port of the React Native app
in `packages/happy-app`, which stays the reference for behaviour, protocol and
design. `packages/happy-ios` is the iOS counterpart; keep the two
architectures comparable (local store, delta sync, crypto layer).

## Scope

- **Latest protocol only.** `packages/happy-wire` and happy-app's current
  sync and encryption code (`sources/sync`, `sources/encryption`,
  `sources/auth`) are the source of truth. Do not port legacy protocol paths:
  sessions and machines without a `dataEncryptionKey` are skipped, not
  decrypted with the account secret.
- **No voice mode** for now.
- **Offline first.** Everything the account has lives on the phone; the
  server is only asked for what changed since the last sync.
- **Tool outputs are hidden by default** once the chat UI exists.
- Built so far: crypto, account auth, the server setting, an empty home
  screen, Settings (Account, Appearance), the local store with delta sync
  and live updates, and onboarding and connect (restore by QR, Link Your
  Computer, troubleshoot, terminal connect by QR, link and deep link). Not
  built: chat and session UI, push.

## Rules

1. **UI is Jetpack Compose** (Material 3 is fine), with the theme and design
   tokens taken from happy-app (`sources/theme.ts`, `constants/Typography.ts`).
   Use the Android branch where theme.ts uses `Platform.select`. Strings are
   generated from happy-app's catalogs (see Localization); never edit
   `res/values*/strings.xml` by hand.
2. **Gradle with the Kotlin DSL and the version catalog**
   (`gradle/libs.versions.toml`). The wrapper is committed; there is no Gradle
   on PATH.
3. **Every component and screen has layout tests** that measure sizes and
   positions against the happy-app spec, and the composable's KDoc states
   that spec. They are Compose UI tests on the JVM through Robolectric (no
   device or emulator): see `app/src/test/.../ui`. Tests run on a
   411x891 dp, xxhdpi phone (`PHONE` in `LayoutTestSupport.kt`), so whole-dp
   values are whole pixels and comparisons are exact to a third of a dp.
   Put test tags on the outermost modifier of the measured box (before
   padding), and look nodes up with `useUnmergedTree = true` (`rule.node`).
4. **The local store is SQLite through the framework API**
   (`SQLiteOpenHelper`, WAL, hand-written SQL in `data/`). Why not a library:
   the schema is a handful of tables whose rows are mostly JSON documents
   keyed by server ids, and the access paths are few and known (upsert a page,
   read by watermark, list newest first). Room would add annotation processing,
   generated code and a migration framework for no query we need; SQLDelight
   adds a build plugin. The framework API costs no dependency and no startup
   time, and `HappyStore` keeps it typed.

## Layout

```
crypto/   pure Kotlin/JVM, no Android: every primitive and key derivation of
          happy-app's encryption, byte for byte. BouncyCastle low-level
          classes (no JCA provider), so it behaves the same on every device.
app/
  auth/     account auth (POST /v1/auth), credentials in expo-secure-store's format
  config/   server URL (survives logout), device-only settings (theme)
  data/     HappyDatabase (schema), HappyStore (typed access + change ticks)
  sync/     AccountSync (per-account owner), SyncEngine (delta sync), LiveUpdates,
            Presence, MessageSync (history), SyncApi + UpdateTypes (wire types)
  net/      HappyHttp (OkHttp + kotlinx.serialization, X-Happy-Client header),
            SocketIoClient (the /v1/updates socket)
  ui/       theme, components (Item, ItemGroup, RoundButton, Header, ...), screens
            onboarding/ welcome, restore, Link Your Computer, onboarding settings
            connect/    QR scanner and codes, connect flows, terminal screens, deep links
            troubleshoot/
  AppGraph  hand-wired object graph; owns the signed-in sync loop
  model/    typed views of the stored JSON: Settings (sync/settings.ts);
            settings/ has agentDefaults.ts, local settings, SettingsRepository
  text/     Resources.plural / pluralResource, PluralExactNumbers (generated)
tools/testvectors/   generates crypto test vectors by running happy-app's TypeScript
tools/translations/  generates the string resources from happy-app's catalogs
```

## Localization

All UI text comes from happy-app's ten catalogs (`sources/text/_default.ts`,
which serves English, and `translations/*.ts`), generated into
`res/values/strings.xml` and `res/values-{ru,pl,es,it,pt,ca,ja,b+zh+Hans,b+zh+Hant}/strings.xml`.
After happy-app's catalogs change, regenerate and commit the output:

```
cd tools/translations && npm run generate
```

`TranslationResourcesTest` fails until you do. A string happy-app doesn't
have goes in `res/values/strings_android.xml` (English only); add it to
happy-app's catalogs instead where you can.

How a catalog entry becomes a resource:

- **Name**: the key path, camelCase to snake_case, dots to `_`
  (`settings.whatsNewSubtitle` → `settings_whats_new_subtitle`). If two keys
  come out alike, the later one keeps its dots as `__`
  (`settingsVoice.language.title` → `settings_voice__language__title`).
- **String**: `stringResource(R.string.common_cancel)`.
- **Function**: a format string whose arguments are the function's
  parameters in `_default.ts`'s annotation order, text as `%n$s` and numbers
  as `%n$d` (pass `Int`):
  `stringResource(R.string.settings_github_connected, login)`.
- **Function that picks words by a count**: `<plurals>`, rendered with
  `pluralResource(R.plurals.time_minutes_ago, count, count)` (or
  `resources.plural(…)`), never `pluralStringResource`: where a catalog
  spells out a number its Android plural category doesn't cover (Japanese
  `count === 1`, Portuguese 0), the generator adds a `<name>_n<number>`
  string, and only `plural` knows to use it. The count is also a format
  argument, in its place among the parameters.
- **Function that picks words by a boolean or a fixed set of strings**: one
  string per case, `<name>_true` / `<name>_false` or `<name>_<value>`
  (`settings.featureToggled({ feature, enabled })` →
  `settings_feature_toggled_true` / `_false`, each taking `feature` as
  `%1$s`; `settings.machineStatus({ name, status })` →
  `settings_machine_status_online` / `_offline`). Choose the resource in
  Kotlin; the chooser is not a format argument.

## Credentials and upgrades from the React Native build

The app reads and writes the account credentials in **exactly** the entry
happy-app uses, so installing this app over the React Native build (same
applicationId) keeps the user signed in, and going back to the RN build
does too. There is no second copy. `auth/ExpoSecureStore.kt` reimplements
expo-secure-store 55.0.9's Android storage (`SecureStoreModule.kt`,
`AESEncryptor.kt`, `HybridAESEncryptor.kt`):

- SharedPreferences file `SecureStore`, key `key_v1-auth_credentials`
  (default keychain service `key_v1`; the unprefixed key of older versions is
  read too).
- Value: JSON `{ct, iv, tlen, scheme: "aes", usesKeystoreSuffix: true,
  keystoreAlias: "key_v1", requireAuthentication: false}`, base64 without
  line breaks; plaintext is tokenStorage.ts's `{"token":…,"secret":…}`.
- AES-256-GCM key in AndroidKeyStore under
  `AES/GCM/NoPadding:key_v1:keystoreUnauthenticated` (no suffix for items
  with `usesKeystoreSuffix: false`). The hybrid RSA scheme (API < 23) is
  read-only, as in expo.
- Failure handling matches expo: a missing Keystore key or one that no
  longer opens the value deletes the entry.

If expo-secure-store is upgraded in happy-app, diff its Android sources
against this file. `ExpoSecureStoreTest` runs a copy of expo's read and write code
against ours in both directions.

**Keystore keys and preferences survive an upgrade only if the new APK has
the same applicationId and is signed with the same certificate as the Play
build.** A different certificate cannot install over it at all, and a
reinstall loses the Keystore key. Release and preview builds must be signed
with the existing EAS/Play signing key; no signing config is checked in.

The custom server URL is not carried over: happy-app keeps it in MMKV
(`server-config`), which this app does not read.

## Sync

`AppGraph.account` is the signed-in account's `AccountSync` (null when
signed out); it owns everything below and stops before sign-out clears the
store. All network, decryption, decoding and SQLite work runs on
`Dispatchers.IO`; the flows can be collected on the main thread.

**Delta sync** (`SyncEngine`). Settings: pending local changes are uploaded
with the version they were based on, merged over the server copy on
`version-mismatch`, then re-read. Machines and profile: read whole (no delta
endpoint; an empty machine list never wipes known machines). Sessions:
`/v2/sessions?changedSince=` from the stored watermark, paged by cursor; a
full listing on first sync and once a day catches deletions. Messages: see
history below. It runs on sign-in, on every socket connect, and when the app
returns to the foreground.

**Store merges** (`HappyStore`). Writes merge instead of overwrite: each
versioned document (metadata, agentState, daemonState) keeps the higher
version, presence the newer `activeAt`, counters the maximum, so a slow page
cannot undo a live update. A write that changes nothing touches no row and
wakes no observer. `versions` counts changes per area (sessions, session
activity, machines, machine activity, account) and per session (messages,
outbox); `messageChanges(id)` and `outboxChanges(id)` are its per-chat views.
Records are stored decrypted (the sandbox and file-based encryption protect
them at rest, as MMKV does for happy-app); their data keys are stored wrapped.

**Live updates** (`net/SocketIoClient`, `sync/LiveUpdates`). The
`/v1/updates` socket (apiSocket.ts) with `clientType: user-scoped`, the
token, `happyClient` and `appState` read at every connect; `app-state` is
sent on every connect and on foreground changes. Why our own client instead
of socket.io-client-java: Happy uses five packet types of Engine.IO 4 /
Socket.IO 5 over WebSocket; the library brings a second Engine.IO stack,
org.json and its own threading for that. OkHttp's WebSocket is already here,
and the wire format is tested directly (`SocketIoProtocolTest`). Reconnects
use socket.io-client's backoff (1 s to 5 s, jitter 0.5, forever); a
heartbeat watchdog drops links silent past `pingInterval + pingTimeout`. The
server keeps no recovery state, so every connect runs the delta sync and
catches up the open chats. `connectionStatus` (`ConnectionStatus`:
disconnected, connecting, connected, error) is what Home's header shows
(homeConnectionStatus.ts: shown unless connected).

Handled updates: `new-message` (next seq is appended; a gap fetches
`after_seq`; turn start/end messages set thinking), `new-session` (stored
from the update itself), `update-session` (metadata/agentState with their
versions, three-state `projectId`; control hand-off refetches messages),
`delete-session`, `new-machine` (carries its data key), `update-machine`,
`delete-machine`, `update-account` (profile fields, settings with version;
pending local settings stay on top), `delete-project` (resync). Projects,
artifacts, friends, feed and KV updates are ignored until those features
exist. Anything that cannot be applied alone (unknown session or machine)
asks for the delta sync instead of guessing.

**Presence** (`sync/Presence`, `account.presence`). `activity` and
`machine-activity` ephemerals and `usage` live in memory only, never in
SQLite. `sessions` / `machines` (`Map<id, SessionPresence | MachinePresence>`)
change only when something shown changes: online/offline, thinking, or an
offline row's last-seen time; heartbeats publish nothing. Stored rows seed
it and the newer `activeAt` wins; the server is the only authority on being
online. Home and Chat read status from here, not from the `active` columns.

**History** (`sync/MessageSync`, `account.messages`). A session's stored
messages are one contiguous seq run (`messages_oldest_seq..messages_seq`).
`messages(sessionId): Flow<List<MessageRecord>>` opens the chat: it fetches
the newest page (`before_seq`), catches up forward, then prefetches up to
five older pages per session per sign-in. `loadOlder(sessionId)` loads one
page on demand and returns whether the run moved back;
`paging(sessionId)` gives `isLoaded`, `hasMoreOlder`, `isLoadingOlder`. A
backward page that does not move the cursor ends history.

## Settings

`AppGraph.settings` (`SettingsRepository`) is the account's settings as
happy-app's `storage.settings` holds them: the stored server copy with
pending changes on top, parsed by `Settings.parse` (settingsParse: every
field of `SettingsSchema` with its default, unknown keys kept in `unknown`;
one field of the wrong type resets all known fields, as zod's `safeParse`
does). Read `settings.settings` (a `StateFlow<Settings>`); change with
`settings.change { it.copy(field = value) }`, which records the changed
top-level keys as pending and asks for a sync. Device-only preferences
(localSettings.ts) are `AppGraph.localSettings.values`, stored as one JSON
document in SharedPreferences.

What's New reads `res/raw/changelog.json`, a byte-for-byte copy of
happy-app's `sources/changelog/changelog.json`, with its images in
`res/drawable-nodpi/changelog_*`. When happy-app's changes, copy it over
(`ChangelogTest` fails until you do); a new image also needs an entry in
`Changelog.images`. `AppGraph.changelog` is the read marker Home's update
banner needs.

## Build and test

```
cd packages/happy-android
./gradlew assembleDebug            # app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest        # app unit + Robolectric layout tests
./gradlew :crypto:test             # crypto, incl. vectors from happy-app's TS
```

Build types map to happy-app's variants and application ids: `debug` →
`com.slopus.happy.dev`, `preview` → `com.slopus.happy.preview`, `release` →
`com.ex3ndr.happy`.

The JDK toolchain (21) is provisioned by the foojay resolver if the machine
only has a JRE. In the agent sandbox Gradle needs network and local sockets:
run it with full access and keep caches in the workspace, e.g.
`GRADLE_USER_HOME=$PWD/../../.context/gradle-home ./gradlew …`.

Crypto vectors (`crypto/src/test/resources/happy-ts-vectors.json`) come from
running happy-app's TypeScript under Node. Regenerate after changing
happy-app's encryption:

```
cd tools/testvectors && npm install && npm run generate
```

## Onboarding and connect

Entry points other screens call (all in `ui/onboarding` and `ui/connect`):

- **Home, no computer linked** (`resolveHomeEmptyState` = link):
  `OnboardingLinkComputer(graph, onSettings = { nav.navigate(OnboardingSettingsRoute) })`.
  **Every computer offline**: `LinkComputerChecklist(graph, computers = choices.map { it.name },
  onTroubleshoot = { nav.navigate(TroubleshootRoute) }, onShowArchived = …)`.
- **Troubleshoot's machine rows**: `onboardingRoutes(graph, nav, onOpenMachine = { id -> … })`
  in HappyApp; pass the machine screen's navigation.
- **Settings › "Scan QR code to authenticate" / "Enter URL manually"**
  (wired in `settingsRoutes`): `val connect = rememberTerminalConnect(graph)`;
  the scan row calls `connect.scan()` and shows `loading = connect.isLoading`;
  the URL row shows `EnterTerminalUrlPrompt(connect, onDismiss = …)` while open.
- **Settings › Account › Link New Device**: `val link = rememberAccountLink(graph)`;
  the row calls `link.scan()`, subtitle `common_scanning` and disabled while
  `link.isLoading`. Both flows show their own alerts while composed.
- **Deep links**: MainActivity offers every launching and new intent to
  `DeepLinks.offer(intent)`; `DeepLinkEffect(nav, signedIn, onOpenSession)`
  in HappyApp opens them once signed in. `onOpenSession` is the chat's.

### QR codes

happy-app scans with expo-camera's `CameraView.launchScanner`, which on
Android is **Google Code Scanner** (`play-services-code-scanner`): Play
services draws its own full-screen camera, so the app holds no CAMERA
permission and shows no preview, and `useCheckCameraPermissions.ts` returns
true on Android. `GmsQrScanner` does the same, behind the `QrScanner`
interface (one call, decoded text out) so the flows are tested with a fake.
Without the Play Store, or when the module fails, the scan returns
`Failed` and nothing is shown, as in happy-app, whose scan listeners never
see a rejected `launchScanner`; the paste-link and secret-key paths still
work. The module is downloaded by Play services on first use, so devices
without Play services (some Huawei, de-Googled ROMs) can't scan in either
app. The merged manifest has no CAMERA permission.

The restore screen draws its code with ZXing's encoder (`zxing-core`, no
Android or camera parts), in QRCode.tsx's rounded style; `QrCodeTest`
decodes the drawn pixels back to the link.

### Deep links

`happy://` links route as expo-router routes them for happy-app (the host
is the first path segment): `happy://terminal?<key>` opens the confirm
screen (terminal/index.tsx), `/terminal/connect` explains that the web link
needs a browser, `/session/<id>` goes to `onOpenSession`. The release build
adds app.config.js's production intent filter for
`https://app.happy.engineering` (`src/release/AndroidManifest.xml`), with
`autoVerify`; verification needs the release key's fingerprint in that
site's `assetlinks.json`. Links while signed out are dropped.

## Stubs to replace

- **Settings › Account › Link New Device** still explains that the scanner
  is missing (`settings_account_link_new_device_unavailable`); Settings wires
  it to `rememberAccountLink` (above) and deletes that string.
