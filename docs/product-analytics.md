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
  `message_sent` (the model, the effort, the provider) is not its own event.
- **No private data.** A property holds a closed enum value, a count, a
  coarse duration bucket, a boolean, a version, or an allowlisted model ID.
  It never holds text, IDs, names, paths, URLs, hosts, error messages, stack
  traces, device model, timezone or screen size. Each client enforces this
  twice. A typed catalog means an unknown event or property does not
  compile, and a runtime allowlist at the send boundary drops anything else.
- **Identity** is a random install UUID, used as `distinct_id`. It is never
  derived from or aliased to an account, agent or `anonId`. There are no
  person profiles: `$process_person_profile: false`, `$ip: null` and
  `$geoip_disable: true` are set on every event.
- **Errors come first.** An error is recorded when a person saw it, not
  when it was thrown.
- **One event per step, named `<object>_<past-tense verb>`.** Each is sent
  when the step succeeds. Nothing is sent for opening a screen, viewing
  something or navigating, and nothing is counted on the device to be sent
  later. Names already in PostHog are kept.
- **Its own module, easy to switch off.** Analytics lives in its own
  package or module on every platform behind one small facade. Deleting the
  module and its call sites removes it. Every client has an Analytics switch
  in Settings that stops sending at once and deletes the queue.
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
  code every 10 minutes per device; the ones held back go in
  `repeat_count`. A failed create is not one: it is its `*_created` event
  with `result: failed`.
- `app_crashed`: the app died abnormally. Reported at the next launch from
  the OS's exit records.
- `mobile_pairing_failed`: a phone pairing ended unlinked, with why.
- `sign_in_failed`: creating, restoring or signing in to an account failed.
  Leaving the flow sends nothing.
- `voice_session_error`: voice failed to start or dropped.
- `paywall_error`: a purchase or restore failed, or a restore found nothing.

Usage:

- `app_opened`: desktop, once per launch. Mobile, a cold start or a return
  after 30 minutes or more in the background. It carries only the
  notification permission, the app language and how many agents are
  connected.
- `conversation_created`: a new conversation starts.
- `message_sent`: the person sends a message. A new conversation is
  `source: new_session`; a send while the agent works is `is_steering`.
- `bot_created` and `task_created`: a create ends, `ok` or `failed`.
- `mobile_pairing_completed` and `mobile_pairing_cancelled`: a phone
  pairing linked, or was left.
- `account_created`, `account_restored`, `team_server_signed_in`: an
  account flow succeeded.
- `voice_session_stopped`: a connected voice session ended normally. It is
  also the voice usage event; there is no start event.
- `paywall_presented`, `paywall_purchased`, `paywall_restored`,
  `paywall_cancelled`: the purchase screen and how a purchase went.

Definitions:

- `launch_count`: launches on this install. Desktop counts renderer
  launches; mobile counts cold starts.
- `agents_connected`: the Happy Agent connections the client has.
- `message_sent` fires on send, even when the message is only queued
  locally. Starting a conversation also sends `conversation_created`.

## iOS (`packages/happy-ios`)

- The SwiftPM target `HappyAnalytics` holds the whole client. HappyCore
  never imports it. `AnalyticsEvent` is the typed catalog.
  `AnalyticsSchema` is the allowlist, built from the same Swift enums.
  `AnalyticsEngine` keeps the queue (500 events, 7 days), the launch
  count, the `error_shown` throttle and the failure dedupe set in
  `Application Support/Happy/analytics.json`. `Analytics.shared` is the
  facade HappyUI and HappyApp call.
- What happens inside HappyCore (a send queued, a create, a start, a shown
  error, a call, an agent connection) is posted on `Happenings`, a hook with
  no analytics in it. HappyAnalytics is its only listener.
- Events are posted to `https://us.i.posthog.com/batch/` in one batch
  every 30 seconds while the app is active and once when it goes to the
  background. There is no PostHog SDK. A failed batch stays queued and is
  sent again later with the same `$insert_id`. Every queued event is
  checked against the catalog again before it is sent.
- Sending stops when the Analytics switch in Settings is off, or when any
  signed-in Happy account has `analyticsOptOut` on. Each account's stored
  setting is read at launch before anything is sent. Turning analytics off
  deletes the queue.
- Crashes and hangs come from MetricKit at the next launch. Only the
  exception type and signal are read, and they are mapped to `reason`.
- A debug run can send to a capture endpoint on the same machine instead
  of PostHog: launch with `HAPPY_ANALYTICS_CAPTURE=http://127.0.0.1:<port>/batch/`.
- Contract test: `Tests/HappyAnalyticsTests/AnalyticsCatalogContractTests.swift`.
- To remove analytics: delete `Sources/HappyAnalytics`,
  `Tests/HappyAnalyticsTests` and the target in `Package.swift`, then the
  `import HappyAnalytics` lines and the `Analytics.shared` calls in HappyUI
  and HappyApp, and `HappyUI/Navigation/AnalyticsBridge.swift`.

## Android (`packages/happy-android`)

- Android uses the same design as iOS. It posts directly to PostHog's
  `/batch/` with OkHttp, next to `PostHogFlags`, and keeps a bounded
  on-disk queue (500 events, 7 days).
- Crashes come from `ActivityManager.getHistoricalProcessExitReasons`
  (API 30+), using its `REASON_*` enum.
- It lives in its own Gradle module, `:analytics`, behind one facade.
- Opt-out works as on iOS. Any signed-in account's `analyticsOptOut` or the
  Analytics switch in Settings stops sending and deletes the queue.
