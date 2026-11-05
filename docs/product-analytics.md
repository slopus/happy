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
- **Not wasteful.** Nothing is sent for opening a screen, viewing
  something or navigating. Nothing is tallied on the device to be sent
  later as a summary.
- **Nothing is sent** from debug builds, tests, UI automation, or a build
  without a PostHog key (Info.plist `HappyPostHogKey` on iOS).

## Events

What each event means, in short. Its exact rule is its `fires` text in the
catalog. Desktop-only onboarding events are left out here.

Errors and results:

- `chat_failure_shown`: a failed agent turn's card is first drawn in the
  conversation the person is looking at, and the failure is at most 5
  minutes old. Once per message per device. `untyped` means a Happy Agent
  error without a typed failure. Happy CLI session errors are not sent.
- `chat_failure_action`: the person acts on a failure card.
- `connection_issue`: the connection to the agent or relay was down for 10
  seconds or more in the foreground. Sent once, when the incident ends.
- `error_shown`: any other error a person saw. At most one per area and
  code every 10 minutes per device; the ones held back go in
  `repeat_count`.
- `app_crash`: the app died abnormally. Reported at the next launch from
  the OS's exit records.
- `pairing_result`: a phone pairing ends: linked, failed or abandoned.
- `sign_in_result`: creating, restoring or signing in to an account ends.
- `voice_session_ended`: a voice session ends, worked or not.
- `purchase_result`: a store purchase or restore ends. `product` is the
  entitlement granted.

Usage:

- `app_opened`: desktop, once per launch. Mobile, a cold start or a return
  after 30 minutes or more in the background. It carries a small
  configuration snapshot.
- `message_sent`: the person sends a message. A new conversation is
  `source: new_session`.
- `feature_used`: one deliberate action, sent when it succeeds. Never for
  opening or viewing anything.
- `onboarding_step_viewed` and `onboarding_completed`: onboarding moves on
  and finishes.
- `pairing_options_shown` and `pairing_option_selected`: temporary, for the
  direct-connection rollout.

Definitions:

- `launch_count`: launches on this install. Desktop counts renderer
  launches; mobile counts cold starts.
- `agents_connected`: the Happy Agent connections the client has.
- `relay_accounts`: Happy CLI (relay) accounts signed in on the phone.
- `provider_kinds` and `provider_accounts`: the model providers configured
  on the active Happy Agent, when the client knows them.
- `message_sent` fires on send, even when the message is only queued
  locally.

## iOS (`packages/happy-ios`)

- `HappyCore/Analytics` holds the whole client. `AnalyticsEvent` is the
  typed catalog. `AnalyticsSchema` is the allowlist, built from the same
  Swift enums. `AnalyticsEngine` keeps the queue (500 events, 7 days),
  the launch count, the `error_shown` throttle and the failure dedupe set
  in `Application Support/Happy/analytics.json`. `Analytics.shared` is the
  only entry point the app calls.
- Events are posted to `https://us.i.posthog.com/batch/` in one batch
  every 30 seconds while the app is active and once when it goes to the
  background. There is no PostHog SDK. A failed batch stays queued and is
  sent again later with the same `$insert_id`.
- Sending stops when the device switch in Settings is off, or when any
  signed-in Happy account has `analyticsOptOut` on. The last value seen for
  each account is remembered. Turning analytics off deletes the queue.
- Crashes and hangs come from MetricKit at the next launch. Only the
  exception type and signal are read, and they are mapped to `reason`.
- A debug run can send to a local capture endpoint instead of PostHog:
  launch with `HAPPY_ANALYTICS_CAPTURE=http://<host>:<port>/batch/`.
- Contract test: `Tests/HappyCoreTests/AnalyticsCatalogContractTests.swift`.

## Android (`packages/happy-android`)

- Android uses the same design as iOS. It posts directly to PostHog's
  `/batch/` with OkHttp, next to `PostHogFlags`, and keeps a bounded
  on-disk queue (500 events, 7 days).
- Crashes come from `ActivityManager.getHistoricalProcessExitReasons`
  (API 30+), using its `REASON_*` enum.
- Opt-out works as on iOS. Any signed-in account's `analyticsOptOut` or the
  device-level switch stops sending and deletes the queue.
