# Product analytics

Happy Desktop and the native iOS and Android apps send the events in
[`analytics-catalog.json`](analytics-catalog.json) and nothing else. Each
event and property is listed there, along with the values it may take and
which clients send it. The catalog is byte-identical in happy-desktop
(`packages/happy-desktop-analytics/catalog.json`). Change it there first and
copy it here. Each client has a unit test that parses the catalog and checks
the client's own typed catalog against it. The taxonomy spec (accepted
2026-11-05) explains why each event exists. Where the spec and the catalog
disagree, the catalog wins. Happy Agent (the daemon) sends nothing.

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
  when it was thrown. Usage is counted locally and sent once a day as
  `daily_summary`, except for `app_opened` and `message_sent`.
- **Nothing is sent** from debug builds, tests, UI automation, or a build
  without a PostHog key (Info.plist `HappyPostHogKey` on iOS).

## iOS (`packages/happy-ios`)

- `HappyCore/Analytics` holds the whole client. `AnalyticsEvent` is the
  typed catalog. `AnalyticsSchema` is the allowlist, built from the same
  Swift enums. `AnalyticsEngine` keeps the queue (500 events, 7 days),
  the `error_shown` throttle, the failure dedupe set and the daily counts
  in `Application Support/Happy/analytics.json`. `Analytics.shared` is the
  only entry point the app calls.
- Events are posted to `https://us.i.posthog.com/batch/` in one batch
  every 30 seconds while the app is active and once when it goes to the
  background. There is no PostHog SDK. A failed batch stays queued and is
  sent again later with the same `$insert_id`.
- Sending stops when the device switch in Settings is off, or when any
  signed-in Happy account has `analyticsOptOut` on. The last value seen for
  each account is remembered. Turning analytics off deletes the queue and
  the pending counts.
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
