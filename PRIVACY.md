# Privacy Policy for Happy Coder

**Last Updated: October 8, 2026**

## Overview

Happy Coder is committed to protecting your privacy. This policy explains how we handle data in our zero-knowledge encrypted synchronization features and in the optional voice feature, which has a separate data flow described below.

## What We Collect

### Encrypted Data
- **Messages and Code**: All your Claude Code conversations and code snippets are end-to-end encrypted on your device before transmission. We store this encrypted data but have no ability to decrypt or read it.
- **Encryption Keys**: When you pair devices, encryption keys are transmitted between your devices in encrypted form. We cannot access or decrypt these keys.

### Metadata (Not Encrypted)
- **Message IDs**: Unique identifiers for message ordering and synchronization
- **Timestamps**: When messages were created and synced
- **Device IDs**: Anonymous identifiers for device pairing
- **Session IDs**: Identifiers for your Claude Code terminal sessions
- **Push Notification Tokens**: Device tokens for sending push notifications via Expo's push notification service

### Analytics (PostHog)
The Happy app sends usage events to PostHog so we can see which features people use and where the app breaks. This is standard product analytics.

- **Pseudonymous ID**: Events are tied to an ID derived from your account's secret key, so one person's events can be linked to each other. We cannot match it back to your Happy account, email, or any other identity.
- **What events contain**:
  - Which screens you open, and app lifecycle events (installed, updated, opened, backgrounded)
  - When you send a message: which app sent it (iOS, Android, web, or desktop); whether it went to a regular session, a bot, or the Chief of Staff, and a built-in bot's internal key such as `chief_of_staff`; how deep the session is (a top-level session or a subtask); whether the session runs on Happy Agent or the Happy CLI, and which CLI agent (for example Claude Code or Codex); the model, the provider type (for example `claude` or `codex`), and the effort level; a short hash that tells your provider accounts apart without naming them; the operating system family of the computer running the agent (macOS, Windows, or Linux); and the Happy app, Happy Agent, and Happy CLI versions
- **What PostHog receives automatically**: your device model, operating system and version, app version and build, language, time zone, and screen size, and the IP address the events come from. PostHog uses that IP address to estimate an approximate location (country and city).
- **What we never send**: message content, prompts, code, file names or paths, project, bot, or account names, provider account IDs, or your email.
- **Opt-Out Available**: You can turn analytics off at any time in Settings. When it is off, the app sends no analytics events.
- **Desktop app**: Happy's desktop app sends similar usage events, tied to a random ID created when it is installed. It has its own switch in Settings → Privacy. PostHog receives the IP address of those requests too; the desktop app does not use it for location.
- **Happy Agent**: Happy Agent itself, the program that runs agents on your computer, sends no analytics.

### Subscription Management (Revenue Cat)
- **Account ID**: Revenue Cat uses your account ID to manage subscriptions and enable premium features
- **Backend Integration**: This ID allows us to provide additional features from our backend while maintaining end-to-end encryption for your content
- **Data Separation**: Purchase analytics sent to PostHog use the pseudonymous analytics ID instead - we cannot match Revenue Cat data with PostHog analytics

### Voice (Optional)
When you turn on voice, your device connects to ElevenLabs to provide the voice agent. Native apps use the ElevenLabs SDK with a LiveKit/WebRTC media connection; the web client uses the ElevenLabs web SDK over WebSocket.

- **Voice Audio**: ElevenLabs receives audio from your microphone during a voice session.
- **Voice Context**: The Happy app sends text to the voice agent so it can assist you. This can include active-session IDs and summaries; the current session's ID, project path, summary, message history, and new messages; session focus or readiness events; and pending permission requests, including the tool name and arguments. It may also include agent tool-call details configured for the voice session.
- **Encryption Boundary**: Voice audio and context sent to the voice agent are not covered by Happy's end-to-end encryption or zero-knowledge architecture. Happy's server does not proxy this audio or context. For Happy-managed voice, it authenticates your Happy account, checks subscription and usage limits, and obtains a voice-session token. It processes account, agent, conversation, and voice-usage metadata for that purpose.
- **Pseudonymous Voice Identifier**: For Happy-managed voice, Happy gives ElevenLabs a stable pseudonymous identifier derived from your Happy account ID using HMAC-SHA-256. This lets ElevenLabs apply per-user voice limits without using your raw Happy account ID as the voice user ID. The identifier can still link your voice sessions to one another.
- **Direct Connection**: If you configure your own ElevenLabs agent and choose to bypass Happy's token flow, Happy bypasses its managed token and usage-limit flow. The selected ElevenLabs agent still receives the voice audio and context described above.

## What We Don't Collect
- Your actual code or conversation content sent through Happy's encrypted synchronization service (we can't decrypt it). This does not include voice audio or context you choose to send directly to ElevenLabs during an active voice session.
- Personal information contained in encrypted messages, because we cannot decrypt those messages. If you use voice, ElevenLabs may receive personal information that you include in voice audio or context.
- Your precise location. The approximate location PostHog estimates from your IP address is described under "Analytics" above.

## How We Use Data

### Encrypted Data
- Stored on our servers solely for synchronization between your devices
- Transmitted to your paired devices when requested
- Retained until you delete it through the app

### Metadata
- Message IDs and timestamps are used to maintain proper message ordering
- Device IDs enable secure pairing between your devices
- Session IDs track your Claude Code terminal sessions for synchronization
- Push notification tokens are stored to enable notifications through Expo's service

### Push Notifications
Push notifications are sent directly from your devices to each other, not from our backend. This means:
- We never see the content of your notifications
- Notification content is generated on your device
- Only device-to-device communication occurs for notification content
- We use Expo's push notification service solely as a delivery mechanism

## Data Security

- **End-to-End Encryption**: Using TweetNaCl (same as Signal) for sensitive data transmitted through Happy's encrypted synchronization service
- **Zero-Knowledge**: We cannot decrypt encrypted synchronization data even if compelled
- **Secure Key Exchange**: Encryption keys are transmitted between your devices only in encrypted form that we cannot access
- **Open Source**: Our encryption implementation is publicly auditable
- **No Backdoors**: The architecture makes it impossible for us to access encrypted synchronization content

The optional voice feature is an exception to the encrypted synchronization model: ElevenLabs must receive the audio and text context it processes to provide the voice agent. See "Voice (Optional)" above.

## Data Retention

- Encrypted messages are retained indefinitely until you delete them
- Metadata is retained for system functionality
- Deleted data is permanently removed from our servers within 30 days
- Voice audio, voice-session context, and voice-usage records processed or retained by ElevenLabs are subject to ElevenLabs' own practices and privacy policy; they are not stored as Happy encrypted synchronization data.

## Your Rights

You have the right to:
- Delete all your data through the app
- Export your encrypted data
- Audit our open-source code
- Use the app without providing any personal information

## Data Sharing

We share data with service providers only as needed to provide the features described in this policy:

- **Expo**: push notification delivery
- **PostHog**: the usage analytics described above
- **RevenueCat**: subscription management
- **ElevenLabs**: the optional voice-agent service and voice-usage measurement. On native apps, voice media uses ElevenLabs' LiveKit/WebRTC transport; the web client uses ElevenLabs' WebSocket-based SDK.

We do not send encrypted synchronization content to these providers as part of ordinary synchronization. Voice audio and context are the exception described in "Voice (Optional)" above.

## Changes to This Policy

We will notify users of any material changes to this privacy policy through the app. Continued use of the service after changes constitutes acceptance.

## Contact

For privacy concerns or questions:
- GitHub Issues: https://github.com/slopus/happy/issues

## Compliance

Happy Coder is designed with privacy by default and complies with:
- GDPR (General Data Protection Regulation)
- CCPA (California Consumer Privacy Act)
- Privacy by Design principles

---

**Remember**: Your encryption keys are only shared between your own devices in encrypted form. We cannot read code or conversations transmitted through Happy's encrypted synchronization service. Content you choose to send through voice is processed by ElevenLabs as described in "Voice (Optional)" above.
