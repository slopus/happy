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
  screen, Settings (Account, Appearance), and the local store with delta
  sync. Not built: chat and session UI, camera and QR screens, terminal
  connect, live updates over the socket, push.

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
  sync/     SyncApi (wire types), SyncEngine (delta sync), InvalidateSync (retry loop)
  net/      HappyHttp: OkHttp + kotlinx.serialization, X-Happy-Client header
  ui/       theme, components (Item, ItemGroup, RoundButton, Header, ...), screens
  AppGraph  hand-wired object graph; owns the signed-in sync loop
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

`SyncEngine` keeps the store current with as little traffic as possible.
Settings: pending local changes are uploaded with the version they were based
on, merged over the server copy on `version-mismatch`, then re-read.
Machines and profile: read whole (small, no delta endpoint). Sessions:
`/v2/sessions?changedSince=` from the stored watermark, paged by cursor; a
full listing on first sync and once a day catches deletions. Messages:
`/v3/sessions/:id/messages?after_seq=` for sessions whose server `seq` is
ahead of the local watermark. Each write commits with its watermark. Records
are stored decrypted (the sandbox and file-based encryption protect them at
rest, as MMKV does for happy-app); their data keys are stored wrapped.

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

## Stubs to replace

- **Account link by QR.** Restore shows where the QR code goes and sends the
  user to the secret key; Settings > Account > Link New Device explains that
  the scanner is missing. The API calls (`AuthApi.requestAccountLink`,
  `approveAccountLink`) and crypto (`AccountLink`) are done and tested.
- **Live updates.** No socket yet; sync runs on sign-in and on every return
  to the foreground.
