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
  Computer, troubleshoot, terminal connect by QR, link and deep link), and
  push notifications. Not built: chat and session UI.

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

