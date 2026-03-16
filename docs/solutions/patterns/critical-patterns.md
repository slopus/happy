# Critical Patterns — Required Reading

These patterns MUST be followed. All subagents check this file before
code generation. Violations of these patterns cause real bugs.

---

## 1. React Native WebRTC: Never Use `navigator.mediaDevices` in Shared Classes

### WRONG (silent audio failure — connection appears live but no audio)
```typescript
// Inside a shared WebRTC client class:
this.localStream = await (navigator?.mediaDevices?.getUserMedia?.({ audio: true }) as any);
```

### CORRECT
```typescript
// Accept mediaDevices as a constructor dependency:
constructor(callbacks, options?: { RTCPeerConnection?: any; mediaDevices?: any }) {
    this.mediaDevicesImpl = options?.mediaDevices ?? navigator?.mediaDevices;
}

// In connect():
if (this.mediaDevicesImpl?.getUserMedia) {
    this.localStream = await this.mediaDevicesImpl.getUserMedia({ audio: true });
}

// Native entry point (RealtimeVoiceSession.tsx):
import { RTCPeerConnection, mediaDevices as rnMediaDevices } from '@livekit/react-native-webrtc';
new OpenAIRealtimeClient(callbacks, { RTCPeerConnection, mediaDevices: rnMediaDevices });

// Web entry point (RealtimeVoiceSession.web.tsx):
new OpenAIRealtimeClient(callbacks); // falls back to navigator.mediaDevices
```

**Why:** `navigator.mediaDevices` is a browser Web API — it is `undefined` in React Native. Optional chaining (`?.`) prevents a crash but silently returns nothing, so execution continues without a mic track. The WebRTC signaling plane (SDP handshake, data channel) completes successfully, making the bug invisible until you notice total audio silence.

**Placement/Context:** Any class that handles WebRTC audio in a codebase that targets both React Native and web. Also applies to `RTCPeerConnection`, `AudioContext`, and other browser media globals.

**Documented in:** `docs/solutions/integration-issues/react-native-webrtc-getusermedia-silent-failure.md`
