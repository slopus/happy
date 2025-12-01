---
title: Enable voice assistant for self-hosted deployment
status: closed
priority: 2
issue_type: task
labels:
- voice
- self-hosted
- elevenlabs
created_at: 2025-12-01T10:30:00+00:00
updated_at: 2025-12-01T19:36:56.046425600+00:00
closed_at: 2025-12-01T19:36:56.046425431+00:00
---

# Description

Voice assistant works on production (app.happy.engineering) and iOS app but fails on self-hosted deployments. The voice button does nothing when clicked.

## Root Cause Analysis

The current implementation uses **hardcoded ElevenLabs agent IDs**:

```typescript
// In RealtimeVoiceSession.tsx and RealtimeVoiceSession.web.tsx:
agentId: __DEV__ ? 'agent_7801k2c0r5hjfraa1kdbytpvs6yt' : 'agent_6701k211syvvegba4kt7m68nxjmw'
```

These agents are owned by Happy's production ElevenLabs account and likely have **domain allowlisting** enabled, only permitting connections from `app.happy.engineering` and the mobile apps.

The client currently connects **directly to ElevenLabs** with just the agentId (public agent mode). The server's `/v1/voice/token` endpoint exists but **is not being called** by the current client code.

## ElevenLabs SDK Authentication Options

The `@elevenlabs/client` SDK supports three session types:

```typescript
// 1. Public Agent (current implementation - requires no server auth)
type PublicSessionConfig = {
    agentId: string;
    connectionType: "websocket" | "webrtc";
};

// 2. Private Agent with Signed URL (WebSocket only)
type PrivateWebSocketSessionConfig = {
    signedUrl: string;  // Generated server-side, valid for 15 minutes
    connectionType?: "websocket";
};

// 3. Private Agent with Conversation Token (WebRTC only)
type PrivateWebRTCSessionConfig = {
    conversationToken: string;  // Generated server-side
    connectionType?: "webrtc";
};
```

## Current Architecture

### Client Side (`happy/sources/realtime/`)
- `RealtimeProvider.tsx` - Wraps app with `ElevenLabsProvider`
- `RealtimeVoiceSession.tsx` (native) / `.web.tsx` - Manages voice session
- Currently uses `agentId` directly (public agent mode)

### Server Side (`happy-server/sources/app/api/routes/voiceRoutes.ts`)
- Endpoint: `POST /v1/voice/token`
- Already fetches `conversationToken` from ElevenLabs API
- Already reads `ELEVENLABS_API_KEY` from environment
- **Not currently called by client**

## Implementation Plan

### Option A: Use Signed URL Flow (Recommended)

This option uses the server as a proxy to generate signed URLs, allowing full control over which ElevenLabs account/agent is used.

#### Step 1: Server Changes
1. Add `ELEVENLABS_AGENT_ID` environment variable
2. Modify `/v1/voice/token` to return a signed URL instead of conversation token:
   ```typescript
   // Change from:
   fetch(`https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${agentId}`)
   // To:
   fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${process.env.ELEVENLABS_AGENT_ID}`)
   ```
3. Return `{ signedUrl: string }` instead of `{ token: string }`

#### Step 2: Client Changes
1. Before calling `startSession`, fetch signed URL from server:
   ```typescript
   const response = await fetch('/v1/voice/token', {
       method: 'POST',
       headers: { 'Authorization': `Bearer ${token}` }
   });
   const { signedUrl } = await response.json();
   ```
2. Use signed URL in `startSession`:
   ```typescript
   await conversationInstance.startSession({
       signedUrl,
       connectionType: 'websocket',
       dynamicVariables: { ... },
       overrides: { ... }
   });
   ```

#### Step 3: Environment Configuration
Required environment variables for happy-server:
```bash
ELEVENLABS_API_KEY=your_api_key_here
ELEVENLABS_AGENT_ID=agent_xxxxxxxxxxxxxx
ENV=dev  # Skip RevenueCat subscription check
```

### Option B: Make Agent ID Configurable (Simpler but less secure)

Keep using public agent mode but make the agent ID configurable.

#### Step 1: Add Environment Variable
```typescript
// In RealtimeVoiceSession.tsx:
const AGENT_ID = process.env.EXPO_PUBLIC_ELEVENLABS_AGENT_ID
    || (__DEV__ ? 'agent_7801k2c0r5hjfraa1kdbytpvs6yt' : 'agent_6701k211syvvegba4kt7m68nxjmw');
```

#### Step 2: Configure Your Agent
1. Create ElevenLabs account
2. Create Conversational AI agent
3. Configure agent as **public** (or add your domain to allowlist)
4. Set `EXPO_PUBLIC_ELEVENLABS_AGENT_ID=your_agent_id`

**Downside**: Your agent is publicly accessible to anyone with the ID.

## ElevenLabs Setup Guide

1. **Create Account**: Sign up at https://elevenlabs.io
2. **Get API Key**: Settings → API Keys → Create new key
3. **Create Agent**:
   - Go to Conversational AI → Agents
   - Create new agent with desired voice/persona
   - Copy the Agent ID (format: `agent_xxxxxxxxxxxx`)
4. **Configure Agent** (for Option B):
   - If using public mode, no additional config needed
   - If using allowlist, add your domain under Agent Settings → Security

## Files to Modify

### Option A (Signed URL):
- `happy-server/sources/app/api/routes/voiceRoutes.ts` - Return signed URL
- `happy/sources/realtime/RealtimeVoiceSession.tsx` - Fetch signed URL before session
- `happy/sources/realtime/RealtimeVoiceSession.web.tsx` - Same changes

### Option B (Configurable Agent ID):
- `happy/sources/realtime/RealtimeVoiceSession.tsx` - Read from env var
- `happy/sources/realtime/RealtimeVoiceSession.web.tsx` - Same changes
- `happy/app.config.js` - Add new env var to expo config

## Testing

```bash
