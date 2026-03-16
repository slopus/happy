---
title: Migrate Voice Layer from ElevenLabs to OpenAI Realtime API
type: migration
status: draft
created: 2026-03-16
brainstorm: docs/brainstorms/2026-03-16-openai-realtime-migration-brainstorm.md
---

# Migrate Voice Layer: ElevenLabs → OpenAI Realtime (WebRTC)

## Summary

Replace the ElevenLabs Conversational AI SDK with a custom WebRTC client
connecting to OpenAI's Realtime API (`gpt-realtime` GA model). The existing
`VoiceSession` interface is the abstraction boundary — everything above it
(voiceHooks, contextFormatters, realtimeClientTools, UI) stays unchanged.

**Why:** OpenAI Realtime GA is ~40% cheaper at moderate usage, removes the
ElevenLabs dependency, gives us direct control over VAD/silence/tools, and
the `semantic_vad` with `eagerness: low` is ideal for the driving use case.

**Scope:** Voice transport layer only. No UI changes. No new features.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  voiceHooks.ts / contextFormatters.ts           │  UNCHANGED
│  realtimeClientTools.ts (3 tools)               │  UNCHANGED (format adapter in client)
├─────────────────────────────────────────────────┤
│  VoiceSession interface (types.ts)              │  MINOR CHANGE (add clientSecret field)
├─────────────────────────────────────────────────┤
│  RealtimeVoiceSession.tsx (native)              │  REPLACED → OpenAIRealtimeClient
│  RealtimeVoiceSession.web.tsx (web)             │  REPLACED → same client (browser WebRTC)
│  RealtimeProvider.tsx                           │  SIMPLIFIED (remove ElevenLabsProvider)
├─────────────────────────────────────────────────┤
│  RealtimeSession.ts                             │  UPDATED (ephemeral key flow)
│  apiVoice.ts                                    │  UPDATED (new endpoint for key)
└─────────────────────────────────────────────────┘
```

## Key Decisions

(see brainstorm: docs/brainstorms/2026-03-16-openai-realtime-migration-brainstorm.md)

1. **WebRTC transport** — not WebSocket. WebRTC handles echo cancellation,
   noise suppression, and codec negotiation automatically. Critical for driving.
2. **Custom client class** (~200 LOC) — no official RN SDK exists. We use
   `@livekit/react-native-webrtc@137.x` which already supports `RTCDataChannel`.
3. **Ephemeral keys** — for production, proxy through Happy server. For dev,
   direct API key is acceptable (already exposed in bundle anyway).
4. **`semantic_vad` with `eagerness: low`** — lets the user pause and think
   without triggering premature turn-ends. Critical for driving UX.
5. **Keep `realtimeClientTools.ts` unchanged** — the OpenAI client class
   translates tool definitions to OpenAI format and routes `function_call`
   events back to the existing tool handlers.

## Event Mapping: ElevenLabs → OpenAI

| ElevenLabs Hook | OpenAI Equivalent | Implementation |
|-----------------|-------------------|----------------|
| `onConnect` | `datachannel.onopen` + `session.created` event | Fire status='connected' |
| `onDisconnect` | `pc.oniceconnectionstatechange → 'closed'` | Fire status='disconnected' |
| `onModeChange('speaking')` | `response.audio.delta` event | Set mode='speaking' |
| `onModeChange('listening')` | `response.audio.done` / `response.done` event | Set mode='idle' |
| `onError` | `error` event on data channel | Set status='disconnected' |
| `sendContextualUpdate(text)` | `conversation.item.create` (role=user, invisible) + NO `response.create` | Silent context injection |
| `sendUserMessage(text)` | `conversation.item.create` (role=user) + `response.create` | Triggers model speech |
| `clientTools[name](params)` | `response.function_call_arguments.done` → execute → `conversation.item.create` (function_call_output) + `response.create` | Same tool functions |

### Critical: `sendContextualUpdate` vs `sendTextMessage`

ElevenLabs distinguishes these natively. OpenAI does not. Our mapping:

- **`sendContextualUpdate`** → `conversation.item.create` with role `user` but
  do NOT follow with `response.create`. The model sees the context but doesn't
  speak about it. Add prefix: `[CONTEXT UPDATE - do not respond to this]`.
- **`sendTextMessage`** → `conversation.item.create` with role `user` then
  `response.create` to trigger a spoken response.

## Tasks

### Task 0: Spike — Verify DataChannel + OpenAI SDP Handshake

**Goal:** Prove the WebRTC connection works end-to-end in React Native before
writing any production code.

**Files:** None (throwaway test)

**Steps:**
1. Create a minimal test script that:
   - Fetches an ephemeral key from OpenAI (`POST /v1/realtime/client_secrets`)
   - Creates `RTCPeerConnection` using `@livekit/react-native-webrtc`
   - Creates data channel `oai-events`
   - Creates SDP offer, POSTs to OpenAI, sets SDP answer
   - Logs data channel `onopen` and first `session.created` event
   - Sends a `session.update` with a simple instruction
   - Adds mic track and verifies audio output
2. Run on physical iPhone to verify audio routing
3. If this fails, we stop and reassess

**Why first:** If DataChannel or SDP handshake doesn't work with the LiveKit
fork, the entire plan is blocked. Find out in 30 minutes, not 2 days.

---

### Task 1: Update `VoiceSessionConfig` Interface

**File:** `sources/realtime/types.ts`

**Change:**
```typescript
export interface VoiceSessionConfig {
    sessionId: string;
    initialContext?: string;
    token?: string;       // ElevenLabs token (keep for backward compat during migration)
    agentId?: string;     // ElevenLabs agent ID (keep for backward compat)
    clientSecret?: string; // OpenAI ephemeral key
    apiKey?: string;       // OpenAI API key (dev only)
    provider?: 'elevenlabs' | 'openai'; // Which backend to use
}
```

**Test:** `yarn typecheck` passes with no new errors.

---

### Task 2: Create `OpenAIRealtimeClient` Class

**New file:** `sources/realtime/openai/OpenAIRealtimeClient.ts`

This is the core of the migration — a ~200 LOC class that:

1. **Manages WebRTC lifecycle** — peer connection, data channel, audio tracks
2. **Handles OpenAI protocol** — session.update, conversation.item.create, response events
3. **Translates tools** — converts `realtimeClientTools` format to OpenAI function-calling schema
4. **Fires callbacks** — onConnect, onDisconnect, onModeChange, onError (matching ElevenLabs shape)

**Public API:**
```typescript
interface OpenAIRealtimeCallbacks {
    onConnect: () => void;
    onDisconnect: () => void;
    onModeChange: (mode: 'speaking' | 'idle') => void;
    onError: (error: Error) => void;
}

class OpenAIRealtimeClient {
    constructor(callbacks: OpenAIRealtimeCallbacks);

    async connect(config: {
        clientSecret?: string;
        apiKey?: string;
        model?: string;
        instructions: string;
        tools: OpenAIToolDef[];
        voice?: string;
        vadConfig?: VADConfig;
    }): Promise<void>;

    disconnect(): void;

    // Maps to sendContextualUpdate (no response triggered)
    injectContext(text: string): void;

    // Maps to sendTextMessage (triggers response)
    sendMessage(text: string): void;
}
```

**Internal flow:**
1. `connect()`:
   - Create `RTCPeerConnection` with `@livekit/react-native-webrtc`
   - Create data channel `oai-events`
   - Get mic stream via `navigator.mediaDevices.getUserMedia` or RN equivalent
   - Add audio track to peer connection
   - Create SDP offer
   - POST offer to `https://api.openai.com/v1/realtime?model=gpt-realtime`
     with `Authorization: Bearer ${clientSecret}` and `Content-Type: application/sdp`
   - Set remote SDP answer
   - Wait for `datachannel.onopen`
   - Send `session.update` with instructions, tools, VAD config
   - Fire `onConnect`

2. Data channel event handler:
   - `session.created` → log, no action needed
   - `response.audio.delta` → set speaking mode (debounced)
   - `response.audio.done` / `response.done` → set idle mode
   - `response.function_call_arguments.done` → execute tool, return result
   - `error` → fire onError
   - `input_audio_buffer.speech_started` → (optional) set 'listening' state
   - `session.ended` → fire onDisconnect

3. ICE state handling:
   - `disconnected` → attempt ICE restart once
   - `failed` → fire onDisconnect, clean up
   - `closed` → fire onDisconnect

4. Cleanup (`disconnect()`):
   - Close data channel
   - Stop all media tracks
   - Close peer connection
   - Fire onDisconnect

**Edge cases to handle:**
- Buffer events until data channel is open (queue `session.update` etc.)
- Guard against double-connect (AsyncLock)
- Handle `response.cancelled` (user interrupts model) — reset mode to idle
- Tool timeout: OpenAI expects response within 15s. If tool takes longer,
  send an optimistic ack.
- Memory cleanup in disconnect: nullify all refs, remove all listeners

**Test:** Unit test with mocked RTCPeerConnection verifying:
- SDP offer/answer exchange
- Data channel event routing
- Tool call → execute → result cycle
- Mode state transitions
- Cleanup on disconnect

---

### Task 3: Create Tool Definition Translator

**New file:** `sources/realtime/openai/toolTranslator.ts`

Converts the existing `realtimeClientTools` format to OpenAI's function-calling schema.

```typescript
export function translateToolsForOpenAI(
    clientTools: Record<string, (params: unknown) => Promise<string>>
): OpenAIToolDef[] {
    // Maps:
    //   messageClaudeCode → { type: "function", name: "messageClaudeCode", ... }
    //   processPermissionRequest → ...
    //   switchSession → ...
    // Uses hardcoded schema definitions matching the Zod schemas in realtimeClientTools
}
```

**Why separate file:** Keeps `realtimeClientTools.ts` unchanged. The translator
knows the parameter schemas and maps them to OpenAI JSON Schema format.

**Test:** Snapshot test that the output matches expected OpenAI tool schema.

---

### Task 4: Build System Prompt for OpenAI

**New file:** `sources/realtime/openai/systemPrompt.ts`

Generates the OpenAI session instructions from the same content currently in
the ElevenLabs agent dashboard. This is now code-controlled instead of
dashboard-configured.

```typescript
export function buildSystemPrompt(initialContext: string): string {
    return `You are Happy Voice, a proactive voice assistant...

ACTIVE SESSIONS:
${initialContext}

YOUR RESPONSIBILITIES:
...

SILENCE BEHAVIOR (CRITICAL):
...

TOOLS:
...`;
}
```

**Advantage:** No more manual dashboard updates. System prompt lives in code,
versioned in git, deployed with the app.

**Test:** Verify prompt includes all required sections; verify initialContext injection.

---

### Task 5: Replace `RealtimeVoiceSession.tsx` (Native)

**File:** `sources/realtime/RealtimeVoiceSession.tsx`

Replace the ElevenLabs `useConversation` hook with `OpenAIRealtimeClient`.

**Before:** React component using `useConversation` hook from `@elevenlabs/react-native`
**After:** React component that instantiates `OpenAIRealtimeClient` in a `useRef`

```typescript
import { OpenAIRealtimeClient } from './openai/OpenAIRealtimeClient';

let clientInstance: OpenAIRealtimeClient | null = null;

class OpenAIVoiceSessionImpl implements VoiceSession {
    async startSession(config: VoiceSessionConfig): Promise<void> {
        if (!clientInstance) return;

        const tools = translateToolsForOpenAI(realtimeClientTools);
        const instructions = buildSystemPrompt(config.initialContext || '');

        await clientInstance.connect({
            clientSecret: config.clientSecret,
            apiKey: config.apiKey,
            instructions,
            tools,
            voice: 'alloy', // or user preference
            vadConfig: { type: 'semantic_vad', eagerness: 'low' }
        });
    }

    async endSession(): Promise<void> {
        clientInstance?.disconnect();
    }

    sendTextMessage(message: string): void {
        clientInstance?.sendMessage(message);
    }

    sendContextualUpdate(update: string): void {
        clientInstance?.injectContext(update);
    }
}

export const RealtimeVoiceSession: React.FC = () => {
    useEffect(() => {
        clientInstance = new OpenAIRealtimeClient({
            onConnect: () => {
                storage.getState().setRealtimeStatus('connected');
                storage.getState().setRealtimeMode('idle');
                // Send session roster (same as current code)
            },
            onDisconnect: () => {
                storage.getState().setRealtimeStatus('disconnected');
                storage.getState().setRealtimeMode('idle', true);
                storage.getState().clearRealtimeModeDebounce();
            },
            onModeChange: (mode) => {
                storage.getState().setRealtimeMode(mode === 'speaking' ? 'speaking' : 'idle');
            },
            onError: (error) => {
                console.warn('OpenAI Realtime error:', error);
                storage.getState().setRealtimeStatus('disconnected');
                storage.getState().setRealtimeMode('idle', true);
            }
        });

        registerVoiceSession(new OpenAIVoiceSessionImpl());

        return () => { clientInstance = null; };
    }, []);

    return null;
};
```

**Test:** Integration test verifying VoiceSession interface contract is met.

---

### Task 6: Replace `RealtimeVoiceSession.web.tsx` (Web)

**File:** `sources/realtime/RealtimeVoiceSession.web.tsx`

Same approach as Task 5 but using browser-native `RTCPeerConnection` instead
of `@livekit/react-native-webrtc`. The `OpenAIRealtimeClient` should accept
a WebRTC factory to support both environments:

```typescript
// In OpenAIRealtimeClient constructor:
constructor(callbacks, options?: { RTCPeerConnection?: typeof RTCPeerConnection })
```

Native passes the LiveKit import, web uses the browser global.

**Test:** Same interface contract test as Task 5.

---

### Task 7: Simplify `RealtimeProvider.tsx`

**File:** `sources/realtime/RealtimeProvider.tsx`

Remove `ElevenLabsProvider` wrapper. The component becomes:

```typescript
export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    return (
        <>
            <RealtimeVoiceSession />
            {children}
        </>
    );
};
```

(This already matches `RealtimeProvider.web.tsx` — they can now be unified.)

**Test:** `yarn typecheck` passes.

---

### Task 8: Update `RealtimeSession.ts` — Ephemeral Key Flow

**File:** `sources/realtime/RealtimeSession.ts`

Replace the ElevenLabs token/agentId flow:

```typescript
// OLD (ElevenLabs):
await voiceSession.startSession({ sessionId, initialContext, agentId });

// NEW (OpenAI):
const secret = await fetchEphemeralKey(); // or use API key in dev
await voiceSession.startSession({
    sessionId,
    initialContext,
    clientSecret: secret,
    provider: 'openai'
});
```

**For dev mode:** Use `config.openAiApiKey` directly (from `EXPO_PUBLIC_OPENAI_API_KEY`).
**For experiments/production:** Call Happy server endpoint to mint ephemeral key.

The `experimentsEnabled` branch stays but calls a new server endpoint instead
of `fetchVoiceToken`. Paywall check remains unchanged.

**Test:** Verify both dev (direct key) and production (server proxy) paths.

---

### Task 9: Add OpenAI Environment Variables

**Files:**
- `app.config.js` — add to `extra.app`
- `sources/sync/appConfig.ts` — add to `AppConfig` interface and loader
- `CLAUDE.local.md` — document new env vars

```bash
EXPO_PUBLIC_OPENAI_API_KEY=sk-...           # Dev only, direct connection
EXPO_PUBLIC_OPENAI_REALTIME_MODEL=gpt-realtime  # Optional override
EXPO_PUBLIC_OPENAI_REALTIME_VOICE=alloy     # Voice selection
```

**Test:** `yarn typecheck`; verify config loads correctly.

---

### Task 10: Audio Output Routing

**File:** `sources/utils/audioRouting.ts` (new)

Ensure audio plays through speaker (not earpiece) for the driving use case.

```typescript
import { Audio } from 'expo-audio';

export async function configureAudioForVoiceSession(): Promise<void> {
    await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        allowsRecordingIOS: true,
        staysActiveInBackground: true,
        // Route to speaker, not earpiece
    });
}
```

Called before `startSession` in `RealtimeSession.ts`.

**Note:** Also need `UIBackgroundModes: audio` in `app.config.js` for iOS
background audio (user switches to Maps while driving).

**Test:** Manual test on physical device — audio plays from speaker.

---

### Task 11: Session Duration Handling

The OpenAI Realtime API has a 30-minute max session duration. For driving,
this needs handling.

**In `OpenAIRealtimeClient`:**
- Track session start time
- At 25 minutes, fire a callback `onSessionExpiring`
- On `session.ended` event, fire `onDisconnect` with a reason
- In `RealtimeSession.ts`, auto-reconnect with new ephemeral key if
  session expires (preserve no conversation state — just reconnect fresh)

**Test:** Simulate session expiry event; verify reconnection.

---

### Task 12: ICE Restart / Network Recovery

**In `OpenAIRealtimeClient`:**
- Listen to `pc.oniceconnectionstatechange`
- On `disconnected`: wait 2s, attempt ICE restart
- On `failed` after restart: full disconnect + reconnect
- On network type change (WiFi→cellular): proactive ICE restart

This is critical for the driving use case — tunnels, dead zones, cell handoffs.

**Test:** Simulate ICE state transitions; verify restart behavior.

---

### Task 13: Remove ElevenLabs Dependencies

**After all tasks verified working:**

1. Remove from `package.json`:
   - `@elevenlabs/react`
   - `@elevenlabs/react-native`
2. Remove language mapping: `sources/constants/Languages.ts` (ElevenLabs codes)
3. Remove `fetchVoiceToken` from `sources/sync/apiVoice.ts`
4. Run `yarn install && yarn typecheck`

**Test:** Full build succeeds with no ElevenLabs references.

---

## Task Dependency Graph

```
Task 0 (spike) ─── GATE ───┐
                            │
Task 1 (types) ─────────────┤
Task 3 (tool translator) ───┤
Task 4 (system prompt) ─────┤
Task 9 (env vars) ──────────┤
Task 10 (audio routing) ────┤
                            │
                            ├──→ Task 2 (client class)
                            │         │
                            │         ├──→ Task 5 (native session)
                            │         ├──→ Task 6 (web session)
                            │         ├──→ Task 8 (session lifecycle)
                            │         │
                            │         ├──→ Task 7 (simplify provider)
                            │         ├──→ Task 11 (session duration)
                            │         └──→ Task 12 (ICE recovery)
                            │
                            └──→ Task 13 (remove ElevenLabs) ← LAST
```

**Parallelizable wave 1:** Tasks 1, 3, 4, 9, 10 (all independent)
**Parallelizable wave 2:** Tasks 5, 6 (after Task 2)
**Sequential:** Task 0 gates everything. Task 13 is last.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| LiveKit WebRTC fork has DataChannel bugs | Low | Blocker | Task 0 spike proves this early |
| OpenAI SDP handshake fails from RN | Low | Blocker | Task 0 spike |
| `sendContextualUpdate` mapping pollutes conversation | Medium | Degraded UX | Prefix with "[CONTEXT UPDATE]" instruction |
| 30-min session limit during long drives | Certain | Interruption | Task 11 auto-reconnect |
| Audio routes to earpiece instead of speaker | Medium | Unusable for driving | Task 10 explicit routing |
| Network drops in tunnels | Certain | Session drops | Task 12 ICE restart |

## Success Criteria

- [ ] Voice connects and audio flows bidirectionally on physical iPhone
- [ ] All 3 tools (messageClaudeCode, processPermissionRequest, switchSession) work
- [ ] Context updates reach the model without triggering speech
- [ ] Text messages trigger model speech
- [ ] Speaking/idle mode transitions drive UI animation
- [ ] Session survives a WiFi→cellular handoff
- [ ] Session auto-reconnects after 30-min expiry
- [ ] Audio plays through speaker, not earpiece
- [ ] `yarn typecheck` passes
- [ ] No ElevenLabs imports remain (after Task 13)
