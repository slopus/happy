# Product analytics

[`analytics-catalog.json`](analytics-catalog.json) is the source of truth.
Happy Desktop and the native iOS and Android apps send the events it lists
and nothing else. It lists each event's properties, the values they may
take, and which clients send the event. The catalog is byte-identical in
happy-desktop (`packages/happy-desktop-analytics/catalog.json`). Change it
there first and copy it here. Each client has a unit test that parses the
catalog and checks the client's own typed catalog against it. Happy Agent
(the daemon) sends nothing.

The rules every client follows:

- **Fewer events, more privacy.** An event earns its place only if it
  answers a question no other event answers. Anything that can be read off
  `message_sent` (the model family, the effort, the provider) is not its own event.
- **No private data.** A property holds a closed enum value, a count, a
  coarse duration bucket, a boolean or a version (numbers only; any
  `-`/`+` suffix is cut, anything else is null). A model is sent as its
  family from the catalog's `model_family_rule`, never as its id.
  It never holds text, IDs, names, paths, URLs, hosts, error messages, stack
  traces, device model, timezone or screen size. Each client enforces this
  twice. A typed catalog means an unknown event or property does not
  compile, and a runtime allowlist at the send boundary drops anything else.
- **Identity** is a random install UUID, used as `distinct_id`. It is never
  derived from or aliased to an account, agent or `anonId`. There are no
  person profiles: `$process_person_profile: false`, `$ip: null` and
  `$geoip_disable: true` are set on every event. Timestamps are whole
  seconds.
- **Nothing on disk but the install id.** The queue, the dedupe set and
  the throttle times live in memory; unsent events are lost when the app
  quits. Opting out deletes the install id with everything else, and
  opting back in makes a new one. A stored switch that can't be read is
  off.
- **Requests** never follow a redirect, and go only to an https host (or
  a loopback capture host in a debug run).
- **Errors come first.** An error is recorded when a person saw it, not
  when it was thrown.
- **One event per step, named `<object>_<past-tense verb>`.** Each is sent
  when the step succeeds. Nothing is sent for opening a screen, viewing
  something or navigating, and nothing is counted on the device to be sent
  later. Names already in PostHog are kept.
- **Its own module, easy to switch off.** Analytics lives in its own
  package or module on every platform behind one small facade. Deleting the
  module and its call sites removes it. Every client has an Analytics switch
  in Settings that stops sending at once and deletes everything analytics
  had.
- **Nothing is sent** from debug builds, tests, UI automation, or a build
  without a PostHog key (Info.plist `HappyPostHogKey` on iOS).

## Events

What each event means, in short. Its exact rule is its `fires` text in the
catalog. Desktop-only events are left out here.

Errors and results:

- `chat_failure_shown`: a failed agent turn's card is first drawn in the
  conversation the person is looking at, and the failure is at most 5
  minutes old. Once per message per device. `untyped` means a Happy Agent
  error without a typed failure. Happy CLI session errors are not sent.
- `chat_failure_action_clicked`: the person taps an action on a failure card.
- `agent_connection_lost`: the connection to the agent or relay was down
  for 10 seconds or more in the foreground. Sent once, when it ends.
- `error_shown`: any other error a person saw. At most one per area and
  code every 10 minutes per device; the ones in between are dropped, not
  counted. A failed create is not one: it is its `*_created` event
  with `result: failed`.
- `app_crashed`: the app died abnormally. Reported at the next launch from
  the OS's exit records, of which only the exception type or signal and the
  app version are read.
- `mobile_pairing_failed`: a phone pairing ended unlinked, with why.
- `sign_in_failed`: creating, restoring or signing in to an account failed.
  Leaving the flow sends nothing.
- `voice_session_error`: voice failed to start or dropped.
- `paywall_error`: a purchase or restore failed, or a restore found nothing.

Usage:

- `app_opened`: desktop, once per launch. Mobile, a cold start or a return
  after 30 minutes or more in the background. It carries only the
  notification permission and how many agents are connected.
- `conversation_created`: a new conversation exists. On iOS that is when
  the Happy Agent has made the new work its first message asked for, or
  when a Happy CLI session started; never when the message is only queued.
- `message_sent`: the person sends a message. A new conversation is
  `source: new_session`; a send while the agent works is `is_steering`.
- `bot_created` and `task_created`: a create ends, `ok` or `failed`.
- `mobile_pairing_completed` and `mobile_pairing_cancelled`: a phone
  pairing linked, or was left.
- `team_server_signed_in`: signing in to a team server succeeded. The
  Happy CLI relay's account flows send only their `sign_in_failed`.
- `voice_session_stopped`: a connected voice session ended normally. It is
  also the voice usage event; there is no start event.
- `paywall_presented`, `paywall_purchased`, `paywall_restored`,
  `paywall_cancelled`: the purchase screen and how a purchase went.

Definitions:

- `agents_connected`: the Happy Agent connections the client has.
- `message_sent` fires on send, even when the message is only queued
  locally. `conversation_created` waits until the conversation exists.

## iOS (`packages/happy-ios`)

- The SwiftPM target `HappyAnalytics` holds the whole client. HappyCore
  never imports it. `AnalyticsEvent` is the typed catalog.
  `AnalyticsSchema` is the allowlist, built from the same Swift enums.
  `AnalyticsEngine` keeps the queue (500 events, 7 days), the
  `error_shown` throttle and the failure dedupe set in memory, and the
  install id in the `happy-analytics` defaults suite, next to the
  Settings switch: the only two things analytics stores. Two errors in
  one area within 10 seconds, while the first is still queued, are one
  failure seen twice (a conversation read when it opens and again on the
  resync after): one `error_shown`, whose `unknown` code gives way to a
  specific one.
  `Analytics.shared` is the facade HappyUI and HappyApp call.
- What happens inside HappyCore (a send queued, a create, a start, a shown
  error, a call, an agent connection) is posted on `Happenings`, a hook with
  no analytics in it. Each post carries closed words and counts only: a
  failure is a `Problem` (its error's type and status), never the error.
  HappyAnalytics is its only listener, and only while analytics is on.
- Events are posted to `https://us.i.posthog.com/batch/` in one batch
  every 30 seconds while the app is active and once when it goes to the
  background, over a session that never follows a redirect. There is no
  PostHog SDK. A failed batch stays queued and is sent again later with
  the same `$insert_id`.
- Nothing is recorded until every signed-in Happy account's stored
  `analyticsOptOut` has been read this launch, and nothing from before is
  kept: only the launch's `app_opened` goes once they allow it. A setting
  changed while they are read wins over what the read found. Accounts'
  settings are never stored by analytics.
- Sending stops when the Analytics switch in Settings is off, or when any
  signed-in Happy account has `analyticsOptOut` on. Turning analytics off
  stops the `Happenings` listener and the connection watch, drops work
  handed on before (an `app_opened` reading its settings included), and
  deletes the queue, the throttle, the dedupe set and the install id at
  once, without waiting for a request on its way. If the switch can't be
  written down, Settings says so.
- The migration card's PostHog flag (`direct-connection-migration-note`)
  is asked for by HappyAnalytics alone, with the same install UUID as
  `distinct_id` and the same rules: a release build with a key, every
  account allowing analytics. Flag targeting is per install, not per
  account. The answer is kept in memory for the launch;
  HappyCore's `MigrationNoteFlag` only holds it, and without
  HappyAnalytics the card never shows.
- Crashes and hangs come from MetricKit at the next launch. Of each, only
  the exception type and signal (mapped to `reason`) and the build that
  crashed are read; never the call stack, the termination text or memory
  regions.
- A debug run can send to a capture endpoint on the same machine instead
  of PostHog: launch with `HAPPY_ANALYTICS_CAPTURE=http://127.0.0.1:<port>/batch/`.
  It never asks for the flag.
- Contract test: `Tests/HappyAnalyticsTests/AnalyticsCatalogContractTests.swift`.

### Removing analytics on iOS

Everything that sends or asks PostHog is inside the module. Outside it,
App and UI code makes only plain calls on `Analytics.shared` with the
app's own types. Paths are under `packages/happy-ios`.

1. Delete `Sources/HappyAnalytics` and `Tests/HappyAnalyticsTests`.
2. In `Package.swift`, remove the six lines that name `HappyAnalytics`:
   - in the `HappyKit` library's target list;
   - the `.target(name: "HappyAnalytics", …)` block and the three comment
     lines above it;
   - in the `HappyUI` dependencies;
   - in the `HappyApp` dependencies;
   - the `.testTarget(name: "HappyAnalyticsTests", …)` block.

   `project.yml` needs nothing: it links the `HappyKit` product.
3. Remove these lines. Each file also has an `import HappyAnalytics`.
   - `HappyApp/AppDelegate.swift`: `Analytics.shared.reportCrashes()`,
     `Analytics.shared.appBecameActive()`, and the background task around
     `Analytics.shared.appEnteredBackground { … }` (its comment, its
     `beginBackgroundTask` line and the call with its closure).
   - `HappyApp/CompositionRoot.swift`: `startAnalytics(…)` and its one call
     in `makeContext`.
   - `HappyUI/Navigation/AppCoordinator.swift`:
     `Analytics.shared.follow(context.account)`, and
     `Task { await Analytics.shared.accountsRestored() }` with its comment.
   - `HappyUI/Navigation/HappyScan.swift`: `Analytics.shared.scanFailed`,
     `Analytics.shared.relayPairingEnded`, `Analytics.shared.accountForComputerEnded`.
   - `HappyUI/Screens/AgentPairingScreens.swift`: `Analytics.shared.directPairingFailed`
     in `PairingFlow`. In `AgentPairingViewController`: the four
     `report { Analytics.shared.… }` calls, `report(_:)` and its `reported`
     flag.
   - `HappyUI/Screens/LegacyLink.swift`: `report()` with its
     `Analytics.shared.relayLinkChanged` and its two calls in
     `receive(status:)` and `receive(network:)`.
   - `HappyUI/Screens/OnboardingScreens.swift`: two `Analytics.shared.accountRestoreFailed`.
   - `HappyUI/Screens/ServerSignInScreen.swift`: `Analytics.shared.teamServerSignedIn()`
     and `Analytics.shared.teamServerSignInFailed`.
   - `HappyUI/Screens/SessionChangesScreen.swift` and
     `HappyUI/Agents/WorkspaceChangesViewController.swift`: `Analytics.shared.diffLoadFailed`.
   - `HappyUI/Screens/SessionListScreens.swift`: `Analytics.shared.refreshMigrationFlag`.
     `refreshMigrationFlag()`, its `didBecomeActiveNotification` observer
     and its call in `apply` then do nothing and can go too.
   - `HappyUI/Agents/ChatViewController.swift`: `Analytics.shared.failureCardShown`
     with `reportFailures()`, `reportFailure(_:)`, its `didBecomeActiveNotification`
     observer, `ultra.onRowShown = …` and the `reportFailures()` call in
     `viewDidAppear`; `Analytics.shared.failureActionClicked`; `let sent =
     Analytics.shared.agentSend(…)` (three lines) and `sent()`;
     `Analytics.shared.fileLoadFailed()`.
   - `HappyUI/Agents/ArtifactViewController.swift`: two `Analytics.shared.artifactLoadFailed`.
   - `HappyUI/Agents/SettingsAccountPages.swift`: `Analytics.shared.pushSetupFailed`.
   - `HappyUI/Agents/SettingsViewController.swift`: `analyticsRow()`, which
     holds `Analytics.shared.deviceOptOut`, `Analytics.shared.setDeviceOptOut`
     and the alert for a switch that couldn't be saved, and its two
     `[analyticsRow()]` sections.
   - `HappyUI/Agents/SupportViewController.swift`: the `viewDidAppear`
     override with `Analytics.shared.paywallPresented()`.
   - `HappyUI/Offers/Offers.swift`: `Analytics.shared.paywallPresented()`
     in `ask`, `Analytics.shared.purchaseEnded`, `Analytics.shared.restoreEnded`.
   - `HappyUI/Browser/BrowserViewController.swift`: `Analytics.shared.browserLoadFailed`.
   - `HappyUI/Call/SessionCallTargets.swift`: `Analytics.shared.voiceSent`.

After that, `grep -rnE 'HappyAnalytics|AnalyticsEvent|Analytics\.shared|ConnectionWatch|AnalyticsBridge'`
over `Sources`, `Tests`, `App`, `Harness`, `project.yml` and `Package.swift`
finds nothing. Before it, outside the module and its tests, it finds 62
lines: the 6 in `Package.swift`, 19 `import HappyAnalytics` lines (one per
file above), and the 37 `Analytics.shared` lines listed.

These neutral pieces stay behind and do nothing without the module. They
can stay or go:

- `HappyCore/Observing/Happenings.swift` (with `Problem` and
  `Happening.Start`) and what posts to it:
  `NewTask.make`, `Conversation` (`errorShown`), `LegacySyncEngine`,
  `OutboxSender`, `CallSession.state`, `AgentConnections.apply` (and its
  `issue`), and `SessionStarter.start` (and `Run.failure`).
- The consent reads: `AccountController.analyticsOptOuts()` and
  `LocalStore.settingsSnapshot(at:)`.
- The alert's words: `Strings.SettingsAccount.analyticsNotSaved` and its
  `native.settingsAccount.analyticsNotSaved` key in every language in
  `HappyCore/Localization/NativeTranslations.swift`.
- `HappyCore/Home/MigrationNoteFlag.swift`, which holds the answer and,
  with nothing asking, hides the card; and the retired
  `posthog.direct-connection-migration-note` key in `LocalSettings`, which
  deletes what older builds kept.
- What the screens hand over: `PairingStart` and `LegacyPairingResult`
  (HappyCore), `Failure`'s `kind`, `providerType`, `pool` and `createdAt`,
  `Snapshot.botAgentIds`, and `ShownRows` with `AgentChatUltraList`'s
  `onScreen`, `onRowShown` and `rowVisibility`.

## Android (`packages/happy-android`)

- The Gradle module `:analytics` (`analytics/`) holds the whole client.
  `AnalyticsEvent` is the typed catalog. `AnalyticsSchema` is the
  allowlist, built from the same Kotlin enums. `AnalyticsClient` keeps the
  queue (500 events, 7 days), the `error_shown` throttle and the failure
  dedupe set in memory, and the install id in the `analytics` prefs, next to
  the Settings switch: the only two things analytics stores. What earlier
  builds kept (`noBackupFilesDir/analytics`, day counts, the per-account
  `feature-flags` prefs) is deleted at start. `Analytics` is the facade the
  app calls; the app maps its own reasons to the catalog's sets in
  `app/…/analytics/`.
- Events are posted to `https://us.i.posthog.com/batch/` with OkHttp in
  one batch every 30 seconds while the app is in front and once when it
  goes behind, never following a redirect. There is no PostHog SDK. A
  failed batch stays queued and is sent again later with the same
  `$insert_id`. Two errors in one area within 10 seconds, while the first
  is still queued, are one `error_shown`, whose `unknown` code gives way to
  a specific one.
- Nothing is recorded until this phone's switch and every signed-in Happy
  account's `analyticsOptOut` have been read: the open account's setting as
  it is now, every other one from its own database. An account that can't
  be read counts as opted out, and so does a stored switch.
- Sending stops when the Analytics switch (Settings › Data and Storage) is
  off, or when any signed-in Happy account has `analyticsOptOut` on.
  Turning analytics off stops the observers (app opens, the connection
  watch, the flag ask), and deletes the queue, the throttle, the dedupe set
  and the install id at once, without waiting for a request on its way. If
  the switch can't be written down, Settings says so.
- The migration card's PostHog flag (`direct-connection-migration-note`)
  is asked for by `:analytics` alone, with the same install UUID as
  `distinct_id` and the same consent, each time the app comes to the
  front. The answer is kept in memory for the launch; the app's
  `FeatureFlags` only holds it, and without the module the card never
  shows.
- Crashes, native crashes, hangs and failed starts come from the system's
  `ApplicationExitInfo` at the next start. Only the reason, the importance
  and the version that crashed are read, never the trace or description. A
  process leaves its version with the system (`setProcessStateSummary`)
  only while analytics is on, so a run with analytics off is never
  reported.
- A debug build sends only to a capture endpoint on the same machine:
  `adb reverse tcp:8787 tcp:8787`, then
  `adb shell setprop debug.happy.analytics_host http://127.0.0.1:8787`.
  It never asks for the flag.
- Contract test: `analytics/src/test/kotlin/com/slopus/happy/analytics/AnalyticsCatalogTest.kt`.

### Removing analytics on Android

Everything that sends or asks PostHog is inside the module. Outside it,
app code calls `Analytics` and its typed events, and maps its own types in
`app/…/analytics/`. Paths are under `packages/happy-android`, and
`app/…` is `app/src/main/kotlin/com/slopus/happy`.

1. Delete `analytics/`, `app/…/analytics/` (`AnalyticsReasons.kt`,
   `ChatAddress.kt`, `AccountsOptedOut.kt`),
   `app/src/test/kotlin/com/slopus/happy/analytics/` and
   `app/src/test/kotlin/com/slopus/happy/ui/conversation/FailureShownTest.kt`.
2. In `settings.gradle.kts`, remove `include(":analytics")` and its
   comment. In `app/build.gradle.kts`, remove
   `implementation(project(":analytics"))` and its comment.
3. Remove these lines. Each file also has its
   `import com.slopus.happy.analytics.…` lines.
   - `AppGraph.kt`: `analyticsTarget`, `analyticsSwitch`,
     `analyticsOptOuts()`, the `init` block that calls `startAnalytics`,
     `startAnalytics`, `analyticsAgent` and `analyticsConfiguration`
     (with the `NotificationManagerCompat` import).
   - `call/CallController.kt`: the `report` field, `val report =
     CallReport()…` in `connect`, `report.observe(state)`, the two `report`
     lines in `close`, and the `CallReport` class.
   - `connection/PairingFlow.kt`: the `record` parameter, the `mismatch`
     and `reported` fields, `mismatch = true` in `reject`, and `report()`
     with its call in `close`.
   - `connection/ServerSignInFlow.kt`: the `record` parameter, the
     `reported` field, and the end of `close` from `if (reported) return`
     to `event?.let(record)`.
   - `conversation/Conversation.kt`: the `address` parameter, the two
     `Analytics.errorShown` lines, `val steering = …` and
     `recordSent(…)` in the send loop, the `try`/`catch` around
     `withRetries { api.createWork(task, choice) }` and `recordCreated(null)`,
     and `recordCreated` and `recordSent`.
   - `sync/MessageSender.kt`: `recordSent(…)` with its call, the two
     `Analytics.errorShown` lines.
   - `payments/Offers.kt`: `Analytics.record(…Presented…)` and its comment.
   - `payments/Subscription.kt`: the `.also { … }` on `restore`'s result,
     `val sheet` and the `when (update)` block in `bought`, the
     `paywall`/`paywallError` calls after `post(…)` (back to
     `if (!post(…)) unconfirmed = true`), and `paywall`, `paywallError`,
     `restoreError` and `storeError` (with the `BillingClient` import).
   - `ui/HappyApp.kt`, `ui/connect/ConnectFlows.kt`,
     `ui/onboarding/OnboardingRoutes.kt`: unwrap the three
     `AnalyticsReasons.signingIn(…) { … }` calls, keeping their blocks.
   - `ui/conversation/ConversationRoutes.kt`: `address = { ChatAddress.of(…) }`,
     `failureShown(…)` and the `onFailureShown = …` line.
   - `ui/conversation/ConversationRowViews.kt`: in `FailureRow`, the
     lifecycle, `onScreen` and `LaunchedEffect` lines and
     `.onVisibilityChanged(…)`; `Analytics.record(…ChatFailureActionClicked…)`
     in Retry's click.
   - `ui/connection/AgentDataStorage.kt`: in `MediaStoragePage`,
     `analytics`, `analyticsNotSaved`, `analytics = analytics`,
     `onAnalytics = …` with its comment, and the `HappyAlert` for
     `analyticsNotSaved`.
   - Tests: `closingAPairingRecordsHowItEndedOnce` with `recorded` and
     `record = …` in `connection/AgentConnectionsTest.kt`, and
     `closingASignInRecordsHowItEndedOnce` in
     `connection/TeamServerTest.kt`.

After that, `grep -rnE 'com\.slopus\.happy\.analytics|":analytics"|analyticsSwitch'`
over `packages/happy-android` finds nothing. Before it, outside the
module and the deleted folders, it finds 87 lines in 19 files: the 2
Gradle lines, the `import com.slopus.happy.analytics.…` lines of the
files above, the 4 expected events in `AgentConnectionsTest`, and the
`analyticsSwitch` lines in `AppGraph.kt` and `AgentDataStorage.kt`.

These neutral pieces stay behind and do nothing without the module. They
can stay or go:

- `connection.PairingStart` and how it reaches `PairingFlow`
  (`ConnectFlow.route`, `LocalAgentPairing`, `DeepLinkEffect`,
  `connectAgent`, `AppGraph.startAgentPairing`).
- `ConversationRow.Failure`'s `kind`, `providerType`, `pool` and
  `createdAt`; `Conversation.Outgoing`'s `voice`; `MessageSender`'s
  `thinking` and `failPending`'s `failed`; the `onFailureShown` hooks on
  `ConversationRowActions` and `ConversationScreenActions`.
- `config/FeatureFlags.kt`, which holds the flag answer and, with nothing
  setting it, hides the migration card, and the deletion of the retired
  `feature-flags` prefs in `AppGraph`.
- `DataStorageScreen`'s `analytics` and `onAnalytics` parameters, its
  `DataStorageTags.ANALYTICS*` tags, and the `settings_analytics_not_saved`
  string in every language.
