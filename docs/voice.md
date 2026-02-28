# Voice Feature Setup

This guide explains how to enable voice conversations in Happy using ElevenLabs Conversational AI.

## Overview

Happy's voice feature uses [ElevenLabs Conversational AI](https://elevenlabs.io/conversational-ai) to enable real-time voice conversations with your AI assistant. This requires:

1. **Server-side**: An ElevenLabs API key (for generating conversation tokens)
2. **App-side**: An ElevenLabs Agent ID (to identify your conversational agent)

## Quick Start

### 1. Create an ElevenLabs Account

1. Sign up at [elevenlabs.io](https://elevenlabs.io)
2. Navigate to your [API Keys](https://elevenlabs.io/app/settings/api-keys)
3. Generate a new API key and save it securely

### 2. Create a Conversational AI Agent

1. Go to [Conversational AI > Agents](https://elevenlabs.io/app/conversational-ai/agents)
2. Click "Create Agent"
3. Configure your agent:
   - Choose a voice
   - Set the system prompt (personality, context, capabilities)
   - Configure knowledge base if needed
4. Copy the **Agent ID** from the agent settings

### 3. Configure the Server

Add your ElevenLabs API key to the server environment:

```bash
# In packages/happy-server/.env or your deployment environment
ELEVENLABS_API_KEY=your-api-key-here
```

### 4. Configure the App

For local development:

```bash
# In packages/happy-app/.env
EXPO_PUBLIC_ELEVENLABS_AGENT_ID_DEV=your-agent-id
EXPO_PUBLIC_ELEVENLABS_AGENT_ID_PROD=your-agent-id
```

For EAS builds:

```bash
# Set as EAS secrets
eas secret:create --name EXPO_PUBLIC_ELEVENLABS_AGENT_ID_DEV --value "your-dev-agent-id"
eas secret:create --name EXPO_PUBLIC_ELEVENLABS_AGENT_ID_PROD --value "your-prod-agent-id"
```

## Configuration Options

### Server Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ELEVENLABS_API_KEY` | Yes | Your ElevenLabs API key for generating conversation tokens |

### App Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `EXPO_PUBLIC_ELEVENLABS_AGENT_ID_DEV` | No | Agent ID for development builds |
| `EXPO_PUBLIC_ELEVENLABS_AGENT_ID_PROD` | Yes* | Agent ID for production builds |

*Required if you want voice features in production.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Happy App  │────▶│ Happy Server │────▶│  ElevenLabs │
│  (Agent ID) │     │  (API Key)   │     │     API     │
└─────────────┘     └──────────────┘     └─────────────┘
       │                    │
       │                    │ GET /v1/convai/conversation/token
       │                    │
       │◀───────────────────┘
       │   (conversation token)
       │
       └──────────────────────────────────────────────▶
                      WebSocket to ElevenLabs
```

1. The app requests a voice token from Happy Server
2. Happy Server validates the user and fetches a token from ElevenLabs
3. The app uses this token to establish a WebSocket connection to ElevenLabs
4. Voice conversation proceeds via the ElevenLabs WebSocket

## Self-Hosted Deployments

When self-hosting Happy, you must configure your own ElevenLabs credentials:

1. Create your own ElevenLabs account and agent
2. Set `ELEVENLABS_API_KEY` on your server
3. Build the app with your agent IDs, or set them via EAS secrets
4. Users connecting to your server will use your ElevenLabs agent

## Troubleshooting

### "Agent ID not configured"

This error appears when the app doesn't have an ElevenLabs agent ID configured.

**Solution**: Set `EXPO_PUBLIC_ELEVENLABS_AGENT_ID_DEV` (for dev) or `EXPO_PUBLIC_ELEVENLABS_AGENT_ID_PROD` (for production) in your environment.

### "Missing 11Labs API key on the server"

The server doesn't have the ElevenLabs API key configured.

**Solution**: Set `ELEVENLABS_API_KEY` in your server environment.

### "Failed to get 11Labs token"

The ElevenLabs API rejected the request.

**Common causes**:
- Invalid API key
- Invalid agent ID
- ElevenLabs account quota exceeded
- Network connectivity issues

### Voice feature not appearing

The voice feature is hidden when:
- Agent ID is not configured
- User doesn't have an active subscription (in production with experiments enabled)

## Cost Considerations

ElevenLabs charges based on:
- Number of conversation minutes
- Characters generated

For self-hosted deployments, monitor your ElevenLabs usage dashboard to track costs.

## Security Notes

- Never commit API keys or agent IDs to version control
- Use environment variables or secrets management
- The server-side API key should never be exposed to clients
- Agent IDs are safe to include in client builds (they identify your agent, not authenticate)

