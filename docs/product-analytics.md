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
  - happy_cli_version
- session_switched
  - last_active_at
  - last_updated_at

## Voice

- voice_message_sent
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
- ota_update_applied
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

## Notes

- session_switched gives recency, but not source. Sidebar vs push vs any other entry point is still merged.
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
