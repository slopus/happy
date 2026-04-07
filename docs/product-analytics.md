# Product Analytics

**Platform:** [PostHog](https://us.posthog.com/project/202516) (US Cloud)  
**Core Dashboard:** [Dashboard #491247](https://us.posthog.com/project/202516/dashboard/491247)  
**Library:** `posthog-react-native`  
**Client-only** — no server-side analytics.

## Setup

- **Init:** `packages/happy-app/sources/track/tracking.ts` — PostHog client created with key from `EXPO_PUBLIC_POSTHOG_KEY`
- **Provider:** `packages/happy-app/sources/app/_layout.tsx:390` — `<PostHogProvider>` wraps the app
- **Screen tracking:** `packages/happy-app/sources/track/useTrackScreens.ts` — auto-tracks route changes (no params, privacy-safe)
- **Auto lifecycle:** `captureAppLifecycleEvents: true` — app open/close/install/update tracked automatically
- **Opt-out:** synced from user settings `analyticsOptOut` flag → `tracking.optOut()` / `tracking.optIn()`
- **Identity:** `tracking.identify(anonymousUserId)` called during auth init

## All Events

All custom events are defined in `packages/happy-app/sources/track/index.ts` unless noted otherwise.

### Auth

| Event | Properties | Trigger | Called From |
|-------|-----------|---------|-------------|
| `account_created` | — | User creates a new account | `app/(app)/index.tsx:45` |
| `account_restored` | — | User restores/links existing account | `app/(app)/index.tsx:71,98,132,158` |

### Core Interactions

| Event | Properties | Trigger | Called From |
|-------|-----------|---------|-------------|
| `connect_attempt` | — | User taps authenticate / manual URL connect | `components/ConnectButton.tsx:15,21` |
| `message_sent` | — | User sends a message in session | `-session/SessionView.tsx:386` |

### Voice

| Event | Properties | Trigger | Called From |
|-------|-----------|---------|-------------|
| `voice_session_started` | `{ sessionId, conversationId? }` | Voice session start is authorized and handed off to ElevenLabs | `-session/SessionView.tsx` (direct capture) |
| `voice_session_error` | `{ sessionId, conversationId?, error }` | Voice session fails to start | `-session/SessionView.tsx` (direct capture) |
| `voice_session_stopped` | `{ sessionId, conversationId? }` | User stops voice session | `-session/SessionView.tsx` (direct capture) |
| `voice_message_sent` | — | Voice assistant sends a message to a session | `realtime/realtimeClientTools.ts:30` |
| `voice_permission_response` | `{ allowed: boolean }` | Voice assistant allows/denies a permission request | `realtime/realtimeClientTools.ts:70,73` |

### Paywall / Monetization

| Event | Properties | Trigger | Called From |
|-------|-----------|---------|-------------|
| `paywall_button_clicked` | — | User taps subscribe button in settings | `components/SettingsView.tsx:66` |
| `paywall_presented` | — | RevenueCat paywall UI shown | `sync/sync.ts:614` |
| `paywall_purchased` | — | User completes purchase | `sync/sync.ts:622` |
| `paywall_restored` | — | User restores previous purchase | `sync/sync.ts:627` |
| `paywall_cancelled` | — | User closes paywall without buying | `sync/sync.ts:632` |
| `paywall_error` | `{ error }` | RevenueCat init/presentation error | `sync/sync.ts:609,640,645` |

### App Review

| Event | Properties | Trigger | Called From |
|-------|-----------|---------|-------------|
| `review_prompt_shown` | — | Initial "do you enjoy this app?" prompt shown | `utils/requestReview.ts:86` |
| `review_prompt_response` | `{ likes_app: boolean }` | User answers yes/no | `utils/requestReview.ts:95` |
| `review_store_shown` | — | Native store review dialog opened | `utils/requestReview.ts:61,114` |
| `review_retry_scheduled` | `{ days_until_retry }` | User declined, retry set to 30 days | `utils/requestReview.ts:108` |

### Feature Discovery

| Event | Properties | Trigger | Called From |
|-------|-----------|---------|-------------|
| `whats_new_clicked` | — | User opens changelog in settings | `components/SettingsView.tsx:353` |

### Friends / Social

> NOTE: Tracking interest to decide whether to keep or remove the friends feature.

| Event | Properties | Trigger | Called From |
|-------|-----------|---------|-------------|
| `friends_search` | — | User opens friend search | `components/MainView.tsx:196`, `components/InboxView.tsx:83` |
| `friends_profile_view` | — | User views a friend's profile | `components/InboxView.tsx:215,232,249` |
| `friends_connect` | — | User sends/accepts friend request | `app/(app)/user/[id].tsx:59`, `app/(app)/friends/search.tsx:39` |

### OTA Updates

| Event | Properties | Trigger | Called From |
|-------|-----------|---------|-------------|
| `ota_update_available` | — | OTA update fetched and ready to apply | `hooks/useUpdates.ts` |
| `ota_update_applied` | — | User taps banner to apply the update | `hooks/useUpdates.ts` |

### Auto-captured (PostHog built-in)

| Event | Source |
|-------|--------|
| `Application Installed` | `captureAppLifecycleEvents` |
| `Application Updated` | `captureAppLifecycleEvents` |
| `Application Opened` | `captureAppLifecycleEvents` |
| `Application Backgrounded` | `captureAppLifecycleEvents` |
| `$screen` | `useTrackScreens()` — route name only, no params |

## Summary

**24 custom events** + auto-captured lifecycle + screen views.

| Category | Count | Notes |
|----------|-------|-------|
| Auth | 2 | |
| Core Interactions | 2 | |
| Voice | 5 | |
| Paywall | 6 | Full RevenueCat funnel |
| App Review | 4 | Full review prompt funnel |
| OTA Updates | 2 | |
| Feature Discovery | 1 | |
| Friends | 3 | Measuring feature interest |

## Gaps / Missing Events

Potential events we're **not** tracking that could be valuable:

- **Session lifecycle** — session started, session ended, session duration
- **Session list interactions** — session tapped, session deleted, session created
- **Settings changes** — theme changed, language changed, notification toggle, analytics opt-out toggle
- **Onboarding funnel** — individual onboarding steps, time-to-first-session
- **Error rates** — connection failures, sync errors, encryption errors
- **Retention signals** — daily/weekly active use (though PostHog can derive from lifecycle events)
- **Voice duration** — how long voice sessions last (start/stop timestamps exist but no duration event)
- **Deep link / notification opened** — what brought user back to the app
- **Share / invite** — user sharing sessions or inviting friends
- **Search** — session search usage and results
