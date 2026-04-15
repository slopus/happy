# Product Analytics

# [auto]

## Navigation

- $screen
  - $screen_name

## Lifecycle

- Application Installed
- Application Updated
  - previous_version?
  - previous_build?
- Application Opened
  - url?
- Application Became Active
- Application Backgrounded

# [explicit]

## Auth

- account_created
- account_restored
  - note: this is restore-flow start, not restore success

## Core

- connect_attempt
- message_sent
  - source
  - session_agent
  - session_started_source
  - happy_cli_version
  - ota_version
  - ota_runtime_version
- session_switched
  - session_id
  - session_created_at
  - last_active_at
  - last_updated_at

## Voice

- voice_permission_response
  - allowed
- voice_session_started
  - session_id
  - elevenlabs_conversation_id
- voice_session_error
  - session_id
  - elevenlabs_conversation_id
  - error
- voice_session_stopped
  - session_id
  - elevenlabs_conversation_id
  - duration_seconds

## Paywall

all include flow property which customizes the upsell screen shown by revenue cat.

- paywall_button_clicked
- paywall_presented
- paywall_purchased
- paywall_restored
- paywall_cancelled
- paywall_error
  - error

## Review

- review_prompt_shown
- review_prompt_response
  - likes_app
- review_store_shown
- review_retry_scheduled
  - days_until_retry

## Updates

- ota_update_available
  - ota_version
  - ota_runtime_version
- ota_update_applied
  - ota_version
  - ota_runtime_version
- whats_new_clicked

## GitHub

- github_connected

## Friends

- friends_search
- friends_profile_view
- friends_connect

# Appendix

## Shared SDK Properties

- every capture(...) send also includes:
  - $lib
  - $lib_version
  - $session_id
  - $screen_height
  - $screen_width
  - $process_person_profile
  - $is_identified
  - $device_type
  - $app_build?
  - $app_name?
  - $app_namespace?
  - $app_version?
  - $device_manufacturer?
  - $device_name?
  - $os_name?
  - $os_version?
  - $locale?
  - $timezone?
  - $screen_name?
  - event
  - distinct_id

## Identity And Control Sends

- $identify
- $set
- reset
- optIn
- optOut

## Strong Preferences

- Prefer a small number of core events with explicit properties over a growing set of overlapping events.
- `message_sent` is the canonical outbound send event. Do not add parallel send events for specific surfaces like voice. Add or use `source` instead.
- If a new analytics question can be answered by extending an existing event, prefer adding a property over inventing a new event.
- `session_switched` should carry stable identity, not just recency. Keep `session_id` and `session_created_at` on it.
- OTA context is first-class and should travel with the events that matter. Keep `ota_version` and `ota_runtime_version` on `message_sent`, `ota_update_available`, and `ota_update_applied`.
- Prefer direct, explicit property objects at capture sites. Do not hide event shape behind generic helper layers that silently add, remove, or filter fields.
- If we ever care about session-switch entry source, add an explicit `source` property. Do not try to reconstruct it later from navigation context.

## Notes

- session_switched now includes stable identity (`session_id`, `session_created_at`) plus recency. Entry source is still merged until we add an explicit source property.
- elevenlabs_conversation_id is the conversation id returned by the ElevenLabs voice session layer.
- github_connected is a plain event with no GitHub profile data attached.

## Relevant Sources

- packages/happy-app/sources/track/index.ts
- packages/happy-app/sources/hooks/useNavigateToSession.ts
- packages/happy-app/sources/-session/SessionView.tsx
- packages/happy-app/sources/realtime/RealtimeSession.ts
- packages/happy-app/sources/components/SettingsView.tsx
- packages/happy-app/sources/sync/sync.ts
- packages/happy-app/sources/track/useTrackScreens.ts
- packages/happy-app/sources/track/tracking.ts
