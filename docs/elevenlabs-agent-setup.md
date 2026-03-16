# ElevenLabs Agent Setup for Happy Coder

## Overview

Happy Coder uses ElevenLabs Conversational AI agents for voice interaction.
The voice agent can send messages to Claude Code sessions and respond to
permission requests — it's not just TTS, it's an interactive AI voice layer.

## Step 1: Create an ElevenLabs Account

Sign up at https://elevenlabs.io — the free tier includes ~15 minutes of
Conversational AI per month, enough to validate the integration.

## Step 2: Create a Conversational AI Agent

1. Go to ElevenLabs dashboard → **Agents** (or Conversational AI)
2. Create a new agent
3. Note the **Agent ID** (you'll need this for the app build)

## Step 3: Configure the Agent

### System Prompt

The agent acts as a voice interface to Claude Code sessions. Use this as the
system prompt:

```
You are Happy Voice, a proactive voice assistant that helps users manage
MULTIPLE Claude Code sessions from their phone while driving or away from
their keyboard.

You act as an aggregating project manager across all active sessions. You will
receive context updates from multiple sessions simultaneously.

ACTIVE SESSIONS (injected at voice start):
{{initialConversationContext}}

YOUR RESPONSIBILITIES:
1. Proactively inform the user when any session finishes work, encounters an
   error, or needs permission — don't wait to be asked.
2. Route messages to the correct session based on the user's intent. If they
   say "on the trading bot, add error handling", match "trading bot" to the
   session folder name and use the messageClaudeCode tool with the session
   parameter.
3. When permission requests come in, tell the user which project needs it and
   what it wants to do. Keep it brief: "Trading bot wants to run npm install.
   Approve?"
4. When the user says "approve" or "deny" without specifying a session, apply
   it to whichever session has a pending request.
5. If the user asks for a status update, summarize all active sessions briefly.

VOICE STYLE:
- Keep it SHORT — 1-2 sentences per update. The user is driving.
- Use project folder names to identify sessions, not IDs.
- Summarize technical details — never read code, file paths, or JSON.
- Be proactive: when a session finishes or needs attention, speak up immediately.

SILENCE BEHAVIOR (CRITICAL):
- Do NOT fill silence. The user is driving and thinking.
- NEVER ask "is there anything else I can help with?" or similar filler.
- NEVER prompt the user to speak when there is a pause.
- Only speak when YOU have something to report (session update, permission
  request, error) or when the USER speaks to you first.
- Silence is normal. Wait quietly. The user will talk when they need you.

TOOLS:
- messageClaudeCode: Send a message to a session. You MUST always specify the
  "session" parameter with the folder name. If the user doesn't name a session,
  ask which one before calling the tool. This also auto-switches the screen.
- processPermissionRequest: Approve or deny. You MUST always specify the
  "session" parameter. When reporting a permission request, always name the
  session so the user's response is unambiguous.
- switchSession: Switch the app screen to show a specific session. Use this
  when the user wants to see a session's output, or when context makes it clear
  which session should be visible. You MUST specify the "session" parameter.
```

### Client Tools

The app registers two client-side tools. Configure these in your ElevenLabs
agent with matching names and schemas:

#### Tool 1: messageClaudeCode

Sends a text message to a Claude Code session. Supports multi-session routing
via the optional `session` parameter (matched against folder names).

```json
{
  "type": "client",
  "name": "messageClaudeCode",
  "description": "Send a message to Claude Code. You MUST specify the 'session' parameter with the project folder name (e.g. 'trading-bot', 'family-journal'). Always ask the user to clarify which session if unclear.",
  "expects_response": false,
  "response_timeout_secs": 1,
  "parameters": [
    {
      "id": "message",
      "type": "string",
      "description": "The message to send to Claude Code",
      "dynamic_variable": "",
      "required": true,
      "constant_value": "",
      "value_type": "llm_prompt"
    },
    {
      "id": "session",
      "type": "string",
      "description": "Target session name (folder name like 'trading-bot'). Always required.",
      "dynamic_variable": "",
      "required": true,
      "constant_value": "",
      "value_type": "llm_prompt"
    }
  ],
  "dynamic_variables": {
    "dynamic_variable_placeholders": {}
  },
  "assignments": [],
  "disable_interruptions": false,
  "force_pre_tool_speech": "auto",
  "tool_call_sound": null,
  "tool_call_sound_behavior": "auto",
  "execution_mode": "immediate"
}
```

#### Tool 2: processPermissionRequest

Approves or denies a pending permission request. Supports multi-session routing.

```json
{
  "type": "client",
  "name": "processPermissionRequest",
  "description": "Approve or deny a permission request from Claude Code. You MUST specify the 'session' parameter with the project folder name. Always confirm which session with the user if unclear.",
  "expects_response": false,
  "response_timeout_secs": 1,
  "parameters": [
    {
      "id": "decision",
      "type": "string",
      "description": "Whether to allow or deny the permission request. Must be 'allow' or 'deny'.",
      "dynamic_variable": "",
      "required": true,
      "constant_value": "",
      "value_type": "llm_prompt"
    },
    {
      "id": "session",
      "type": "string",
      "description": "Target session name (folder name). Always required.",
      "dynamic_variable": "",
      "required": true,
      "constant_value": "",
      "value_type": "llm_prompt"
    }
  ],
  "dynamic_variables": {
    "dynamic_variable_placeholders": {}
  },
  "assignments": [],
  "disable_interruptions": false,
  "force_pre_tool_speech": "auto",
  "tool_call_sound": null,
  "tool_call_sound_behavior": "auto",
  "execution_mode": "immediate"
}
```

#### Tool 3: switchSession

Switches the app screen to show a specific session. Also called automatically
when sending a message, but can be used standalone (e.g. "show me the trading bot").

```json
{
  "type": "client",
  "name": "switchSession",
  "description": "Switch the app screen to display a specific session. Use when the user asks to see a session, or when context makes it clear they want to view a different project. Always specify the session name.",
  "expects_response": false,
  "response_timeout_secs": 1,
  "parameters": [
    {
      "id": "session",
      "type": "string",
      "description": "Target session name (folder name like 'trading-bot'). Always required.",
      "dynamic_variable": "",
      "required": true,
      "constant_value": "",
      "value_type": "llm_prompt"
    }
  ],
  "dynamic_variables": {
    "dynamic_variable_placeholders": {}
  },
  "assignments": [],
  "disable_interruptions": false,
  "force_pre_tool_speech": "auto",
  "tool_call_sound": null,
  "tool_call_sound_behavior": "auto",
  "execution_mode": "immediate"
}
```

### Dynamic Variables

The system prompt uses `{{initialConversationContext}}` — this is a dynamic
variable that the app fills with the full list of active sessions when voice
starts. In ElevenLabs dashboard:

1. Go to your agent → **System Prompt** section
2. When you type `{{initialConversationContext}}` it should auto-register as
   a dynamic variable
3. If it doesn't, go to **Dynamic Variables** and add one named
   `initialConversationContext` with an empty default value

The app also sends `sessionId` as a dynamic variable (the session the user
was viewing when they tapped the mic button).

### Agent Settings

| Setting | Recommended Value |
|---------|------------------|
| **Access** | Public (unauthenticated) — needed for direct agentId connection |
| **Voice** | Pick any ElevenLabs voice you like |
| **Language** | The app sends user's preferred language, but default to English |
| **LLM** | Use the default (ElevenLabs absorbs LLM costs for now) |
| **Max duration** | 10 minutes (or whatever your plan allows) |

### Silence / End-of-Turn Settings

In the ElevenLabs agent dashboard, look for these settings and adjust:

| Setting | Recommended Value |
|---------|------------------|
| **Inactivity timeout** | Maximum allowed (or disable if possible) |
| **End call on silence** | Disabled (user is driving, long silences are normal) |

The system prompt already instructs the agent not to fill silence, but these
platform-level settings reinforce that behavior.

**Important:** The agent MUST have public/unauthenticated access enabled for the
direct-connect path (experiments=false). If you want token-based auth instead,
you'd need to self-host the Happy server with your `ELEVENLABS_API_KEY`.

## Step 4: Build the App

```bash
cd /Users/cr/Scripts/AI-Dev/happy

# Install dependencies
yarn install

# Build for iOS simulator
cd packages/happy-app
EXPO_PUBLIC_ELEVENLABS_AGENT_ID_DEV=<your_agent_id> yarn prebuild
EXPO_PUBLIC_ELEVENLABS_AGENT_ID_DEV=<your_agent_id> yarn ios:dev
```

## Step 5: Test Voice

1. Open the app in the simulator
2. Authenticate with the CLI (`happy` command on your Mac)
3. Open a Claude Code session
4. Tap the microphone button in the session view
5. Grant microphone permission
6. Speak — the agent should respond and can relay messages to Claude Code

## Context Updates the Agent Receives

The app automatically sends contextual updates to the voice agent:

| Event | What the agent sees |
|-------|-------------------|
| Session focus | Which session the user is looking at |
| New messages | Claude Code's responses, tool calls, user messages |
| Permission requests | Tool name, arguments, request ID |
| Session online/offline | Connection status changes |
| Ready event | "Claude Code done working" notification |

These arrive as contextual updates (not user messages), so the agent can
proactively inform the user about what's happening.

## Cost Estimate

| Usage | Minutes/month | Cost (Creator plan, $11/mo) |
|-------|---------------|----------------------------|
| Light (quick checks) | ~30 min | Included in 250 min |
| Moderate (daily use) | ~120 min | Included in 250 min |
| Heavy (constant voice) | ~500 min | Need Pro plan ($99/mo) |

Free tier: 15 min/month for testing.
