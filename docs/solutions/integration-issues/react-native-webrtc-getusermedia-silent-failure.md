---
module: Voice Layer (OpenAI Realtime API Integration)
date: 2026-03-16
problem_type: integration_issue
symptoms:
  - Speakerphone activates but no audio flows in either direction
  - Microphone capture fails silently with no crash or visible error
  - Model speech output not received despite connected status
  - WebRTC connection appears fully established (SDP handshake, session.created event)
root_cause: OpenAIRealtimeClient used browser API navigator.mediaDevices.getUserMedia() which does not exist in React Native; requires mediaDevices imported from @livekit/react-native-webrtc
resolution_type: code_fix
severity: critical
tags:
  - react-native-webrtc
  - openai-realtime-api
  - cross-platform-api
  - dependency-injection
  - voice-integration
  - browser-api-incompatibility
---

# React Native WebRTC: `navigator.mediaDevices` Silently Fails — Complete Audio Silence

## Problem

When using `@livekit/react-native-webrtc` for the OpenAI Realtime API voice integration, calling `navigator?.mediaDevices?.getUserMedia()` inside a shared WebRTC client class silently fails in React Native. The WebRTC connection completes successfully (SDP handshake, data channel open, `session.created` event received) but no mic track is ever added to the peer connection and no remote audio plays — total silence in both directions.

## Symptoms

- Voice button tap activates the speakerphone (iOS audio session changes) — looks connected
- `[OpenAIRealtime] Connected` log appears, UI shows "connected" state
- No mic input detected by the model (model never responds)
- No model audio output despite `response.audio.delta` events potentially arriving
- Metro logs show: `[OpenAIRealtime] Mic not available: ...` (if not swallowed) or nothing at all

## What Didn't Work

**Assuming the WebRTC connection itself was broken:** SDP handshake logs showed success and `session.created` arrived on the data channel. The signaling plane was fine — the issue was in the media plane.

**Using `navigator?.mediaDevices?.getUserMedia?.({ audio: true })`:** `navigator.mediaDevices` is `undefined` in React Native (no browser host). Optional chaining prevented a hard crash but silently swallowed the failure. Execution continued without a mic track, and the try/catch logged only a warning — the session appeared live while audio was completely broken.

## Solution

Inject `mediaDevices` as a constructor dependency on the WebRTC client class. The native entry point passes the RN-specific implementation; the web entry point falls back to the browser global.

**Before (broken):**
```typescript
// OpenAIRealtimeClient.ts
constructor(callbacks, options?: { RTCPeerConnection?: any }) {
    this.RTCPeerConnectionCtor = options?.RTCPeerConnection ?? globalThis.RTCPeerConnection;
}

// Inside connect():
this.localStream = await (navigator?.mediaDevices?.getUserMedia?.({ audio: true }) as any);
```

**After (fixed):**
```typescript
// OpenAIRealtimeClient.ts
constructor(
    callbacks: OpenAIRealtimeCallbacks,
    options?: { RTCPeerConnection?: any; mediaDevices?: any }
) {
    this.RTCPeerConnectionCtor = options?.RTCPeerConnection ?? globalThis.RTCPeerConnection;
    this.mediaDevicesImpl = options?.mediaDevices ?? navigator?.mediaDevices;
}

// Inside connect():
if (this.mediaDevicesImpl?.getUserMedia) {
    this.localStream = await this.mediaDevicesImpl.getUserMedia({ audio: true });
    // ...add track to peer connection
}
```

**Native session — RealtimeVoiceSession.tsx:**
```typescript
import { RTCPeerConnection, mediaDevices as rnMediaDevices } from '@livekit/react-native-webrtc';

clientInstance = new OpenAIRealtimeClient(callbacks, {
    RTCPeerConnection,
    mediaDevices: rnMediaDevices,  // ← RN-specific implementation
});
```

**Web session — RealtimeVoiceSession.web.tsx:**
```typescript
// No override needed — falls back to navigator.mediaDevices (browser native)
clientInstance = new OpenAIRealtimeClient(callbacks);
```

## Why This Works

React Native runs JavaScript on Hermes (or JSC) — not a browser. `navigator.mediaDevices` is a W3C Media Capture spec API that only exists because browser vendors implement it as part of their platform. In React Native there is no browser host, so the property is `undefined`. `@livekit/react-native-webrtc` ships its own `mediaDevices` export that bridges to the native iOS/Android media subsystem — nearly identical API surface to the browser version, which is exactly what makes the bug invisible until runtime.

Dependency injection solves this structurally: the client class never reaches for a platform global. The caller (native or web session file) supplies the correct implementation at construction time. An incorrect implementation fails loudly at the wiring point; a missing one is immediately obvious. The bug becomes impossible to introduce silently.

The real danger with optional chaining (`?.`) is that it turns "this global doesn't exist" into "silently do nothing" — which in audio code means silent operation, the hardest possible failure mode to debug.

## Prevention

1. **Never access `navigator.*` or `window.*` directly inside shared/cross-platform classes.** Any file that is imported by both a `.tsx` and `.web.tsx` must not reference browser globals. Add an ESLint `no-restricted-globals` rule for `navigator` and `window` in `sources/realtime/` and similar shared directories.

2. **Treat swallowed catch blocks as defects when the fallback is broken.** A `catch` that logs a warning and continues without the mic is not defensive — it's a silent failure. If the resource is required for the feature to work, the error must propagate or result in an explicit `error` status.

3. **Apply the platform injection pattern to all RN/Web split capabilities:** `mediaDevices`, `RTCPeerConnection`, `AudioContext`, `localStorage`, clipboard, biometrics. Accept them as constructor arguments. Wire them in the platform-specific entry files (`.tsx` vs `.web.tsx`).

4. **Verify the media plane separately from the signaling plane.** SDP handshake success and `session.created` on the data channel only prove signaling works. A test or smoke check should assert at least one audio track was added to the peer connection before claiming "connected."

5. **When porting Web API code to React Native, grep for:** `navigator.`, `window.`, `document.`, `globalThis.`, `AudioContext`, `localStorage` — treat every hit as a porting defect until confirmed otherwise.

## Related Issues

None identified.
