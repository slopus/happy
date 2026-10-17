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
- **Voice** uses Happy's server-controlled allowance and RevenueCat paywalls,
  with ElevenLabs over WebRTC. The pinned SDK source patch in
  `vendor/elevenlabs` fixes audio focus, teardown and call-local mute.
- **Offline first.** Everything the account has lives on the phone; the
  server is only asked for what changed since the last sync.
- **Tool outputs are hidden by default** once the chat UI exists.
- The port includes auth, offline/live sync, home and session management,
  chat/composer/tools, attachments, diffs/files, onboarding/connect, settings,
  push, tablet layouts, purchases and voice. Experimental and social surfaces
  remain excluded. Store validation needs the existing signing identity,
  EAS build number and RevenueCat Google SDK key.

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
   **Font scale:** text scales with the system font size, uncapped, as RN's
   does: sizes and line heights in sp (`happyTextStyle`), never dp. Icons,
   paddings and avatars stay in dp (`Icon` converts its size with `toSp()`,
   which undoes the non-linear curve). A box that holds text takes its RN
   height as `heightIn(min = …)`, so it is exact at 1.0 and grows instead of
   clipping; where RN keeps a fixed height and lets text overflow visibly
   (the header bar, Home's timestamp slot), keep the height and give the text
   `wrapContentHeight(unbounded = true)`. The only cap is the onboarding
   titles' 1.2. `ui/layout/FontScaleLayoutTest` checks screens at 2.0. Under
   Android 14's non-linear scaling Compose keeps each line height's ratio to
   its font, where RN converts the line height separately, so at large
   scales our lines run a few dp taller.
   **Tablet:** `ui/layout/WindowLayout.kt` answers responsive.ts and
   layout.ts through `LocalWindowLayout` (the tablet shell is width ≥ 768;
   the 9-inch diagonal only sets the 800 content max width). Read it, not
   `LocalConfiguration`, for any `useIsTablet` branch; hold wide content with
   `Modifier.contentMaxWidth` or `CenteredInputWidth`. `ui/tablet/TabletShell`
   wraps HappyApp's NavHost; under it `LocalTabletShell` is true and
   `HeaderBackButton` renders nothing. Tablet tests use
   `w1280dp-h800dp-xhdpi`; without `ProvideWindowLayout` a composable lays
   out as an unlimited phone.
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
            Presence, MessageSync (history), MessageSender (outbox), MessageMeta,
            RpcClient + SessionOps + MachineOps (ops.ts), SessionComposer (picks
            and drafts), HappyAgentGit, RigCapabilities, SyncApi + UpdateTypes
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
tools/testvectors/   generates crypto and send vectors by running happy-app's TypeScript
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

Where happy-app calls `t()`, use the catalog key; never re-type its English.
Where happy-app writes English inline instead (most of HomeDock, the machine
screen, info.tsx's activity rows, the agents and push-diagnostics settings,
useStartSessionFromDraft's errors), the port stays English too: on screens, in
`strings_<area>.xml` (`strings_home.xml`, `strings_tablet.xml`,
`strings_push.xml`, `strings_android.xml`) or inline with a note naming the
happy-app file. Text built outside composition stays a Kotlin literal, word for
word as happy-app has it: tool titles (`chat/tools`), slash-command
descriptions (`autocomplete`), reducer events, spawn, worktree and changes
errors, and the push diagnostics in `model/settings/Push.kt`. So do brand and
product names ("Claude Code", "OpenAI Codex", "Happy Engineering"). When
happy-app moves one of these into its catalogs, switch to the key.

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
with the existing EAS/Play signing key; no signing config is checked in
(see "Versions and signing").

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

**How big it gets, and logout.** happy-app keeps no messages on disk at all:
they live in memory for the run (its decrypt cache holds 1000) and are
fetched again on the next start. Here they stay in SQLite so a chat opens
offline and at once, and nothing prunes them: a session's rows go when the
session is deleted (`ON DELETE CASCADE`), and only chats that were opened
are stored, each from its newest page back as far as the reader scrolled
plus the five-page background budget. That is the bound, recorded rather
than enforced; a chat's rows are one contiguous run of seqs, so trimming
the middle would break paging. Migrations keep everything from schema 1 on
(`DatabaseMigrationTest`, one test per hop). Logout (`AppGraph.logout`):
the `beforeLogout` hooks first, while signed in (the push unregister); then
the database, local settings, the What's New marker, the new-session draft
(stored and in memory, `afterLogoutWipe`), picked-image copies and the
image loader's caches; then the credentials. The server choice stays
(`LogoutWipeTest`).

**Large sessions** (`perf/LargeDataTest`, `perf/ChatDisplayTimingTest`).
The reducer, ChatFeed and HomeListModel derive off the collecting thread
and stay linear. What still runs in ChatList's composition per snapshot was
measured at 5040 rows (JVM, median after warm-up): `groupChatRowsForDisplay`
1.3–2.6 ms, `chatListItems` 0.5–0.8 ms, `WorkGroupExpansion.observed`
0.2 ms. Below the 8 ms line, so it stays on the main thread; the guard fails
only at 50 ms, a quadratic rather than noise.

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
pending local settings stay on top), `new-project`/`update-project` (the
project catalog refetches, `ProjectServices`), `delete-project` (the catalog
and a resync). Artifacts, friends (`relationship-updated`) and feed updates
are ignored until those features exist; KV updates are ignored because KV is
unused by happy-app (nothing imports apiKv.ts). Not copied on purpose:
`update-session`'s account `seq` (here a session's `seq` is its message
counter, which history sync relies on), and the `session-event` ephemeral
(happy-app's browser-tab unread counter). Anything that cannot be applied alone (unknown session
or machine, a `new-session` body that does not decode) asks for the delta
sync instead of guessing.

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
backward page that does not move the cursor ends history. `preload(sessionId)`
is Home's press-down (`HomeListCallbacks.onPressDown`, sync.ts
`preloadSession`): the newest page only, one session at a time (another
touch drops it), skipped for a chat that is open or already stored, never
retried, and no visit, read or older history. A plan-mode switch in that page
waits for the chat to open (`StoredSource.PRELOAD`/`OPENED`).

**Sending** (`sync/MessageSender`, `account.sender`). `send(sessionId, text,
meta)` builds the user record exactly as sync.ts `sendMessage` does (sentFrom
`android`, delivery meta, `appendSystemPrompt`, the mode fields, displayText;
`meta` is laid over it), seals it with the session key, writes it to the
`outbox` table and returns the localId; it throws `SendException` when
nothing was queued (session not synced, a permission mode the session's CLI
cannot parse). The mode and delivery meta are resolved as messageMeta.ts
does (`MessageMetaResolver`) from the composer mirror, agent defaults and
presence. A per-session loop POSTs everything queued to
`/v3/sessions/:id/messages` with backoff. `send(..., attachments = records)`
queues pre-built plaintext records (attachment `file` events) ahead of the
text, in order, sealed and retried the same way; rows go `QUEUED` → `SENDING` →
`SENT` (stored, waiting for its echo) and are deleted when the echo is
stored. `FAILED` (a 4xx the server will repeat, or still unsent 30 s into
the background) waits for `retry` or `discard`. Rows survive restarts; an
interrupted send is re-queued at start (the server dedupes on localId). The
POST answer never moves the message cursor; it asks for a catch-up. Chat
reads delivery state from `sender.outbox(sessionId)` / `store.outbox`. The
record is checked byte for byte against happy-app's own `sendMessage`
(`tools/testvectors/send.mjs` → `app/src/test/resources/happy-ts-send-vectors.json`).

**Ops** (`account.sessionOps`, `account.machineOps`). ops.ts over
`rpc-call` (params and result sealed with the session's or machine's data
key, 50 s ack timeout) and HTTP. Session: abort, allow/deny with mode,
allowed tools and decision, question answers, kill, archive, delete,
switch, goal action, avatar, bash and files. Happy Agent sessions are asked
only what they advertise (`RigCapabilities.kt`, rig.ts gates). Machine:
spawn (incl. Happy Agent's `happy-agent-spawn`), resume with the data-key
fallback, stop session/daemon, bash, delete, rename, Claude/Codex fork,
duplicate and rewind points, `forkAndSpawn`, side chats. Commands throw
`RpcException`; calls with a result type return the failure in it.
`account.git` is Happy Agent's native Git changes (happyAgentGit.ts).

**Composer** (`sync/SessionComposer`, `account.composer`). Each session's
draft and picks (`ComposerMirror`: storage.ts's mirror fields), stored in
the `composer` table. `setAgentModes(id, mapOf(field to value))` is ops.ts
`sessionSetAgentModes`: applied at once and pushed with `update-metadata`
(kept while in flight, then metadata wins). On a Happy Agent session the
picks and text are one stamped draft written per rigComposer.ts: typing
debounced 250 ms, picks and clears at once, one write in flight, adopt a
remote draft stamped the same or later, restore from disk and flush on
reconnect. `setText`, `clearDraft`, `mirrors` / `mirror(id)`.

### Recreation and process death

The manifest handles orientation, screen size and uiMode, so rotation,
folding and a dark/light switch don't recreate the activity. A font scale
or locale change does, and so does the system after process death.
`StateRestorationTest` covers both: the same graph for a recreation, a new
graph over the same database and keys for process death.

- Kept through both: the open screen (the nav back stack is saved), the
  chat's composer draft (the session composer's mirror is in the
  database), the chat list's scroll position, the home dock's text and
  focus (`rememberSaveable`), and an open composer or dock picker.
- Kept through a recreation only: Restore's QR request (a ViewModel).
- Lost, as in happy-app: pending chats (memory only), open alerts and
  confirmations, an in-flight Resume or Stop spinner, Restore's QR request
  after process death.

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

Run agent Android builds, unit tests and device checks on Kirill's Mac Mini
over SSH, syncing the sources first. The commands below run there; CI keeps
its configured Linux runner.

```
cd packages/happy-android
./gradlew assembleDebug            # app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest        # app unit + Robolectric layout tests
./gradlew :crypto:test             # crypto, incl. vectors from happy-app's TS
```

Build types map to happy-app's variants and application ids: `debug` →
`com.slopus.happy.dev`, `preview` → `com.slopus.happy.preview`, `release` →
`com.ex3ndr.happy`.

### Versions and signing

- `versionName` is happy-app's `version`, read from `app.config.js` at
  configuration time, so the two apps never drift. `HAPPY_VERSION_NAME` or
  `-Phappy.versionName` overrides it.
- `versionCode` is EAS's remote, auto-incremented build number
  (`eas.json` `appVersionSource: remote`). There is no counter in the repo:
  a store build passes the next number as `HAPPY_VERSION_CODE` or
  `-Phappy.versionCode`, above the last RN upload. Local builds get 1.
- Signing comes from the environment (`HAPPY_RELEASE_KEYSTORE`,
  `_KEYSTORE_PASSWORD`, `_KEY_ALIAS`, `_KEY_PASSWORD`, and the same with
  `HAPPY_PREVIEW_`) or a gitignored `keystore.properties`
  (`keystore.properties.example` lists the keys). Without them `release`
  builds unsigned and `preview` debug-signed, so `assembleRelease` works
  anywhere, CI included.
- A signed release or preview build without an explicit versionCode fails in
  `pre<Variant>Build`, before R8, rather than at the Play console.
- Shipping goes through the `release` skill like every other release.
- CI: `.github/workflows/happy-android.yml` runs `assembleDebug
  assembleRelease testDebugUnitTest :crypto:test` on changes under
  `packages/happy-android/` (and happy-app's `app.config.js`, which sets the
  version). It has no signing secrets.

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

The send vectors are generated the same way, from sync.ts's `sendMessage`
itself; regenerate after changing it or the system prompt:

```
cd tools/testvectors && npm install && npm run generate:send
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
is the first path segment), and so do `https://app.happy.engineering/<path>`
links. Every app path maps to its Compose route (`parseDeepLink` in
`ui/connect/DeepLinks.kt`): `terminal?<key>` opens the confirm screen,
`/terminal/connect` explains that the web link needs a browser,
`/session/<id>` goes to `onOpenSession`, and `/session/<id>/info|changes|
file?path=<btoa>|message/<mid>`, `/machine/<id>`, `/new`, `/settings/*`,
`/server`, `/restore[/manual]`, `/troubleshoot`, `/changelog` and
`/onboarding/settings` open their screens. Paths with no Android screen
(excluded features, `session/recent`, the files browser) open Home. The
release build adds app.config.js's production intent filter for
`https://app.happy.engineering` (`src/release/AndroidManifest.xml`), with
`autoVerify`. The site's `assetlinks.json` (happy-app's
`public/.well-known/assetlinks.json`) already lists `com.ex3ndr.happy` with
one fingerprint, presumably Play's app-signing key that the React Native app
verifies with, so a Play-distributed build should verify as it does; a build
signed with only the upload key won't. Signed out, only the screens that need
no account (server, restore, troubleshoot, changelog, onboarding settings)
open; other links are dropped rather than pushed onto empty signed-in screens.

## Push

What happy-app does with expo-notifications, without Expo:

- **Token.** FCM token → Expo push token, exactly as expo-notifications
  55's getExpoPushTokenAsync: `POST https://exp.host/--/api/v2/push/getExpoPushToken`,
  only `content-type: application/json`, body
  `{type:"fcm",deviceId,development:false,appId,deviceToken,projectId}` in
  that key order (`ExpoPushTokenClient`). `deviceId` is expo's
  InstallationId, read from the same no-backup file (and legacy places), so
  an upgrade from the React Native build keeps its device id. The project
  id is app.config.js's `extra.eas.projectId`. happy-server only knows Expo
  tokens and sends through Expo, so this exchange is not optional.
- **Registration** (`PushRegistrar`, pushRegistration.ts): register with
  `POST /v1/push-tokens`, remember it, drop the previously registered token
  if it changed; all happy-server calls retry like apiPush.ts's `backoff`.
  `PushRegistrationEffect` in HappyApp runs it on sign-in and every return
  to the foreground. It shows the POST_NOTIFICATIONS prompt only while the
  system would still show it, never opens settings by itself, and forgets
  the registration on sign-out. `HappyMessagingService.onNewToken`
  re-registers a rotated FCM token.
- **Showing.** Expo relays a push as an FCM data message (`title`,
  `message`, `body` = the data as JSON, `channelId`); `presentPush` shows it
  on its channel, silent while the app is in the foreground. Channels are
  `_layout.tsx`'s: `default` (max) and `messages` (high, what happy-server
  uses), vibration 0/250/250/250, light #FF231F7C.
- **Tapping** opens MainActivity with `ACTION_OPEN_PUSH` and the session id
  from notificationRouting.ts's rules (a `/session/<id>` url, else
  `sessionId`); `DeepLinks.offer` turns it into `DeepLink.Session`, which
  `DeepLinkEffect` hands to `onOpenSession` (the chat's).
- **Background sends** (sync.ts's watchdog notifications,
  `push/BackgroundSendNotifications.kt`): MessageSender's watchdog fails
  rows unsent 30 s into the background; this observer of the store's
  outbox and `AppGraph.isForeground` schedules "Message not sent" with an
  inexact AlarmManager alarm (`BackgroundSendReceiver`) when the app leaves
  with unsent rows, cancels it on return or once they are sent, and posts
  "Message failed" when rows fail with `MessageSender.BACKGROUND_FAILURE`.
  Both go on the `default` channel and open the app.
- **Settings › Account's push rows** use `rememberPushRegistration(graph)`,
  Settings' `PushRegistration` over the same registrar and permission
  (pushRegistration.ts's getPushPermissionInfo,
  requestPushPermissionOrOpenSettings, getCurrentExpoPushToken,
  syncCurrentPushToken, removePushToken).

**Firebase is optional at build time.** There is no google-services
plugin: `app/build.gradle.kts` reads `app/google-services.json`, else
happy-app's committed `packages/happy-app/google-services.json`, and
generates the plugin's resources for the client matching each variant's
application id. Without a file or a matching client the app builds and runs
and push reports unsupported (no prompt, nothing registered). Pushes arrive
only if:

- the file has clients for `com.ex3ndr.happy`, `com.slopus.happy.preview`
  and `com.slopus.happy.dev` (happy-app's has all three);
- the Expo project above has that Firebase project's FCM V1 service
  account key (happy-app's Android pushes already depend on it; a
  different Firebase project needs its key uploaded to Expo);
- the device has Play services (otherwise unsupported, as FCM has no
  token there).

## Purchases

`AppGraph.purchases` owns RevenueCat's optional account lifecycle. The public
Google SDK key is supplied by `EXPO_PUBLIC_REVENUE_CAT_GOOGLE` or
`-Phappy.revenueCatGoogleKey`; an empty key leaves purchases unavailable.
`purchases.purchases` is the flat `StateFlow<Purchases>` from purchases.ts,
cached per server/account and wiped on logout. Configure with the token's
server-issued subject as appUserID. Startup/foreground and successful paywalls
sync purchases and fetch customer info. SDK operations serialize with paywalls;
account generations reject stale results after logout, account or server changes.

`suspend purchases.presentPaywall(flow)` (also `Paywall.present`) uses the
current offering and the `flow` custom variable, never an offering named after
the flow. `PaywallHost` at app scope renders RevenueCat's native Compose dialog
and dismisses on account changes. Purchased and Restored return
`PaywallOutcome(success = true, purchased = true)` after refresh; closing returns
success with purchased false. `hasPro()` reads the real entitlement for voice;
Settings' Support us row additionally treats debug builds as Pro, as RN does.
The row is inert for Pro and otherwise presents `voluntary_support`.

## Voice

`AppGraph.voice` owns one `VoiceEngine`. It requests microphone permission
before allocating a server conversation, applies server denial/paywall rules,
and connects the ElevenLabs transport. `AppGraph.purchases` provides real Pro
state and paywalls; debug-only Support us behavior does not grant voice Pro.
Usage and credentials re-authenticate with the account secret when voice uses
a different server. Voice language codes come from `VoiceLanguages`.

`StoreVoiceContext` forwards normalized messages, permission prompts, ready
events and focused-session context. Histories load lazily with a 50-row cap;
events arriving during SDK connection are buffered. Client tools validate
their parameters and use the existing sender/permission RPCs for the bound
account. Logout, failed start and stop invalidate callbacks and close the call.

`vendor/elevenlabs/UPSTREAM.md` records the pinned MIT source archive and the
audio lifecycle patch. LiveKit owns audio focus and device routing; call mute
never changes global microphone mute. Room cleanup completes logically before
stop returns, and LiveKit's audio thread releases OS focus asynchronously.
Verify focus, recording and communication mode on a device after changes.
`testDebugUnitTest` includes the SDK's lifecycle tests as well as app tests.

## Attachments and images

- **Transfer** (`attachments/`): apiAttachments.ts over OkHttp. Local
  storage is PUT/GET back to the server with the bearer token (only when
  the URL is the server's); S3 is a presigned multipart POST (policy
  fields, then `file`) and a presigned GET with no Happy headers. Every
  failure is an `AttachmentDiagnosticError` whose message and diagnostic
  went through attachmentDiagnostics.ts's redaction, so they can be logged.
- **Crypto**: blobs are `encryptBlob` (secretbox, nonce || box) under the
  session's blob key, `deriveKey(dataKey, "Happy Blobs", ["session"])`
  (`SessionBlobKeys`, from the stored wrapped data key).
- **Sending**: the composer's images are normalized at pick time (upright,
  long edge ≤ 3072, JPEG 0.92, `<stem>.jpg`, ≤ 10 MB − 40 so the encrypted
  blob fits), uploaded on send (`prepareAttachmentSend`: flavor and rig
  policy, then upload; a failed image is counted, not fatal), and handed to
  `ChatActions.send(..., attachments = fileEventRecords(uploaded))`, which
  queues sync.ts's `file` session events ahead of the text.
- **Picking**: the Android photo picker (`PickVisualMedia`), so no storage
  permission (happy-app blocks READ_MEDIA_IMAGES); paste reads an image
  URI from the clipboard. The add button always asks Paste or Library, as
  useImagePicker does. No thumbhash on Android, as on happy-app native.
- **Showing**: `file` tool rows render `FileMessageView`, which downloads
  and decrypts on demand through `AttachmentTransfers` (50-entry LRU of
  decrypted blobs, one download per ref).

### Image loading

One Coil 3 `ImageLoader` (`ui/components/RemoteImage.kt`) for every
picture that isn't bundled: profile pictures by URL (`Avatar` with an
http(s) `imageUri`), markdown images (`MarkdownImage`), and attachment
thumbnails and file messages (decrypted bytes, keyed by ref). Coil because
it is Compose-first and coroutine-based, sizes decodes to the view,
brings the memory and disk caches expo-image gives happy-app, and plugs
into our OkHttp; Glide is View-first with an annotation processor, and a
hand-rolled loader would re-implement caching and downsampling. The
loader uses its own OkHttp client without Happy headers (these URLs are
third-party). Tests swap it through `LocalImageLoader` with coil-test's
`FakeImageLoaderEngine`.

### Mermaid

`ui/components/MermaidView.kt` renders ```` ```mermaid ```` blocks the way
happy-app's native MermaidRenderer does: a WebView loading mermaid@11 from
jsdelivr, its height posted back through a `ReactNativeWebView` JS
interface (200 until reported, capped at 600). Where there is no WebView
(Robolectric, devices without a provider) `LocalMermaidWebView` is false and
MarkdownView's code block shows instead; layout tests see the code block
unless they provide `true`.

## Autocomplete

`@` file mentions and `/` commands in the chat composer. Logic is in
`autocomplete/` (plain Kotlin, unit-tested against happy-app's own test
cases): `findActiveWord`/`applySuggestion`, `searchCommands` (session
metadata's slash commands and skills, minus `IGNORED_COMMANDS`), and
`FileSearchCache` (`rg --files --follow` over Sync's session ripgrep RPC,
kept 5 minutes). Ranking is `Fuse.kt`, a port of the Fuse.js 7.1 subset
happy-app uses; `FuseTest` holds scores produced by fuse.js itself, so
regenerate them from fuse.js if the options change rather than editing
them by hand. The UI is `ui/autocomplete/`: ChatRoute provides
`LocalSuggestionSource`, ChatScreen passes `ComposerSuggestions` into
ChatComposer's `overlay` slot and the shared `ComposerCursor` into its
`cursor` parameter (the composer reports the selection, places the cursor
after an insert, and offers hardware keys to `cursor.onKey` first: arrows,
Enter/Tab and Escape drive the list while it shows).
