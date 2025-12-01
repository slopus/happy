# Happy Voice Agent Setup

Scripts to create and manage the ElevenLabs Conversational AI agent for Happy.

## Prerequisites

1. An ElevenLabs account at https://elevenlabs.io
2. An API key with **Conversational AI** permission enabled
   - Go to https://elevenlabs.io/app/settings/api-keys
   - Create a new key or edit existing one
   - Enable the "Conversational AI" permission

## Quick Start

```bash
# Set your API key
export ELEVENLABS_API_KEY=sk_your_api_key_here

# Create or update the Happy Coding Assistant agent
./setup-agent.sh
```

The script will output the `ELEVENLABS_AGENT_ID` to add to your happy-server environment.

## Scripts

### `setup-agent.sh`

Creates or updates the "Happy Coding Assistant" agent with:
- System prompt from `system_prompt.md`
- `messageClaudeCode` client tool
- `processPermissionRequest` client tool
- Patience settings (no "are you still there?" nagging)

**Idempotent**: Running multiple times is safe - it will update the existing agent.

### `list-agents.sh`

Lists all your ElevenLabs agents with their IDs.

```bash
./list-agents.sh
```

### `get-agent.sh`

Shows detailed configuration for a specific agent.

```bash
./get-agent.sh agent_xxxxx
```

### `delete-agent.sh`

Deletes an agent (with confirmation prompt).

```bash
./delete-agent.sh agent_xxxxx
```

## Client Tools

The agent is configured with two client tools that the Happy app implements:

### `messageClaudeCode`

Sends a message to Claude Code on behalf of the user.

- **Parameter**: `message` (string) - The message to send
- **Returns**: "sent" on success

### `processPermissionRequest`

Handles permission requests from Claude Code.

- **Parameter**: `decision` (string) - Either "allow" or "deny"
- **Returns**: "done" on success

## Environment Variables for happy-server

After running `setup-agent.sh`, add these to your happy-server:

```bash
ELEVENLABS_API_KEY=sk_your_api_key
ELEVENLABS_AGENT_ID=agent_xxxxx  # Output from setup-agent.sh
```

## Customization

Edit `system_prompt.md` to customize the assistant's personality and behavior, then run `./setup-agent.sh` again to update the agent.
