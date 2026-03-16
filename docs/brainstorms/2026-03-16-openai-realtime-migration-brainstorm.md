---
date: 2026-03-16
topic: openai-realtime-migration
status: active
origin: brainstorming session
---

# Migrate Voice Layer: ElevenLabs → OpenAI Realtime

## What We're Building

Swap the voice backend from ElevenLabs Conversational AI to OpenAI's Realtime API
(`gpt-realtime` GA model). The migration is surgical: the `VoiceSession` interface
is already provider-agnostic, so only the implementation layer changes.

The driving use case is unchanged: hands-free multi-session Claude Code management
while driving — voice agent monitors N parallel sessions, routes messages, handles
permission requests, and stays silent unless it has something to say.

## Why This Approach

Three approaches were evaluated:

**A — WebRTC (chosen):** `react-native-webrtc` is already installed in the project
as a config plugin. OpenAI recommends WebRTC for mobile clients. Audio quality is
best-in-class (Opus, echo cancellation, WebRTC congestion control). No manual
PCM16 encoding needed. thorwebdev demo provides a reference implementation.

**B — Raw WebSocket:** Simpler transport but requires manual audio encoding (PCM16
at 24kHz), manual echo cancellation, and TCP fragility on mobile networks.

**C — Server-proxied:** Cleanest key management but requires running self-hosted
happy-server. Deferred — not needed for personal use.

## Key Decisions

- **Transport:** WebRTC via `react-native-webrtc` (already in project)
- **Model:** `gpt-realtime` GA (not `-preview`; those are deprecated Sept 2025)
- **Auth (dev):** `EXPO_PUBLIC_OPENAI_API_KEY` baked at Metro bundle time (same
  pattern as current `EXPO_PUBLIC_ELEVENLABS_AGENT_ID_DEV`)
- **Auth (prod):** Ephemeral keys via `POST /v1/realtime/client_secrets` before
  each session — API key stays server-side
- **VAD:** `semantic_vad` with `eagerness: low` — won't cut off mid-sentence;
  no silence-filling per system prompt
- **Tools:** Same `realtimeClientTools` object — zero changes. OpenAI function
  calling uses the same zod-validated async callback pattern.
- **Context injection:** `conversation.item.create { role: "system" }` replaces
  `sendContextualUpdate()` — direct equivalent
- **Session names:** Same `{{initialConversationContext}}` pattern — inject on
  connect via `session.update` instructions field
- **Scope:** Only 3 files change (RealtimeVoiceSession.tsx, .web.tsx,
  RealtimeProvider.tsx). Everything else is untouched.

## Architecture: What Changes vs What Stays

### Files that change
| File | Change |
|---|---|
| `RealtimeVoiceSession.tsx` | Replace ElevenLabs `useConversation` hook with WebRTC client |
| `RealtimeVoiceSession.web.tsx` | Same for web — browser WebRTC APIs |
| `RealtimeProvider.tsx` | Remove `<ElevenLabsProvider>` wrapper |
| `package.json` | Remove `@elevenlabs/*` packages |
| env config | Add `EXPO_PUBLIC_OPENAI_API_KEY` |

### Files that stay identical
- `types.ts` — VoiceSession interface (provider-agnostic)
- `RealtimeSession.ts` — session control singleton
- `realtimeClientTools.ts` — all 3 tools (messageClaudeCode, processPermissionRequest, switchSession)
- `hooks/voiceHooks.ts` — event routing
- `hooks/contextFormatters.ts` — message formatting
- `voiceConfig.ts` — feature flags

## Data Flow

```
Tap mic
  → requestMicrophonePermission()
  → fetch ephemeral key: POST /v1/realtime/client_secrets (prod)
    OR use EXPO_PUBLIC_OPENAI_API_KEY directly (dev)
  → RTCPeerConnection to api.openai.com/v1/realtime/calls
  → RTCDataChannel "oai-events" for all signaling
  → Audio track: mic stream → WebRTC → OpenAI
                 OpenAI → WebRTC → speaker (auto-routed)

On connect:
  → session.update: { model, voice, instructions (system prompt + session roster),
                       tools: [messageClaudeCode, processPermissionRequest, switchSession],
                       turn_detection: { type: "semantic_vad", eagerness: "low" } }

On tool call:
  → response.function_call_arguments.done event received
  → realtimeClientTools[name](params) called (unchanged)
  → conversation.item.create { type: "function_call_output" }
  → response.create to resume

On sendContextualUpdate(text):
  → conversation.item.create { role: "system", content: [{ type: "text", text }] }
  → response.create (only if no response in-flight)
```

## Tool Schema (OpenAI format)

Tools are registered in `session.update` as standard OpenAI function calling JSON.
No ElevenLabs-specific format needed:

```json
{
  "type": "function",
  "name": "messageClaudeCode",
  "description": "Send a message to a Claude Code session...",
  "parameters": {
    "type": "object",
    "properties": {
      "message": { "type": "string" },
      "session": { "type": "string" }
    },
    "required": ["message", "session"],
    "additionalProperties": false
  },
  "strict": true
}
```

## Pricing Impact

At moderate usage (~120 min/month):
- ElevenLabs Creator: $11/month flat
- OpenAI `gpt-realtime` GA: ~$120 × $0.057/min ≈ $6.84/month

At heavy use (500 min/month):
- ElevenLabs Pro: $99/month
- OpenAI: ~$28.50/month

OpenAI is cheaper at scale. The old preview models were 3-4× more expensive; GA pricing
made this favorable.

## Resolved Questions

- **react-native-webrtc already in project?** Yes — `@config-plugins/react-native-webrtc: ^12.0.0`
  and `@livekit/react-native-webrtc: ^137.0.0` both present.
- **Audio handling in RN?** WebRTC handles it natively via mic stream; no manual PCM16 encoding.
- **Official OpenAI SDK in RN?** Not supported. We write a minimal custom WebRTC client class
  (~200 LOC) that conforms to `VoiceSession`. No SDK dependency needed.
- **Language codes?** OpenAI uses BCP-47 (e.g. "en-US") — simpler than ElevenLabs codes.
  Replace `getElevenLabsCodeFromPreference()` with a trivial BCP-47 mapper.
- **System prompt / session roster?** Same approach — pass as `instructions` in `session.update`
  on connect. `{{initialConversationContext}}` variable pattern replaced by actual string injection.

## Open Questions

_(none — all resolved above)_

## Next Steps

> Run `/workflow:write-plan` to produce the TDD implementation plan.

Estimated scope: ~2-3 days of implementation work
- Day 1: WebRTC client class + session.update + connect/disconnect
- Day 2: Tool calling event loop + context injection
- Day 3: Testing, ElevenLabs cleanup, env config docs
