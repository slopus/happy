#!/bin/bash
#
# Setup ElevenLabs Voice Agent for Happy
#
# This script creates or updates the "Happy Coding Assistant" agent
# with the required client tools configuration.
#
# Usage: ./setup-agent.sh
#
# Required environment variable:
#   ELEVENLABS_API_KEY - Your ElevenLabs API key with convai_write permission
#
# The script is idempotent - if the agent already exists, it will update it.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_NAME="Happy Coding Assistant"

# Check for API key
if [ -z "$ELEVENLABS_API_KEY" ]; then
    echo "Error: ELEVENLABS_API_KEY environment variable is not set"
    echo ""
    echo "Get your API key from: https://elevenlabs.io/app/settings/api-keys"
    echo "Make sure it has the 'Conversational AI' permission enabled."
    echo ""
    echo "Usage: ELEVENLABS_API_KEY=sk_xxx ./setup-agent.sh"
    exit 1
fi

# Read system prompt from file
if [ ! -f "$SCRIPT_DIR/system_prompt.md" ]; then
    echo "Error: system_prompt.md not found in $SCRIPT_DIR"
    exit 1
fi

SYSTEM_PROMPT=$(cat "$SCRIPT_DIR/system_prompt.md")

echo "=== ElevenLabs Voice Agent Setup ==="
echo ""

# Check if agent already exists by listing agents and searching for our name
echo "Checking for existing agent '$AGENT_NAME'..."

AGENTS_RESPONSE=$(curl -s -X GET "https://api.elevenlabs.io/v1/convai/agents" \
    -H "xi-api-key: $ELEVENLABS_API_KEY" \
    -H "Accept: application/json")

# Check for API errors
if echo "$AGENTS_RESPONSE" | grep -q '"detail"'; then
    echo "Error from ElevenLabs API:"
    echo "$AGENTS_RESPONSE" | jq -r '.detail.message // .detail // .'
    exit 1
fi

# Find existing agent by name
EXISTING_AGENT_ID=$(echo "$AGENTS_RESPONSE" | jq -r ".agents[] | select(.name == \"$AGENT_NAME\") | .agent_id" 2>/dev/null || echo "")

# Build the agent configuration JSON
AGENT_CONFIG=$(cat <<EOF
{
  "name": "$AGENT_NAME",
  "conversation_config": {
    "agent": {
      "first_message": "Hey! I'm your voice interface to Claude Code. What would you like me to help you with?",
      "language": "en",
      "prompt": {
        "prompt": $(echo "$SYSTEM_PROMPT" | jq -Rs .),
        "llm": "gemini-2.5-flash",
        "temperature": 0.7,
        "max_tokens": 1024,
        "tools": [
          {
            "type": "client",
            "name": "messageClaudeCode",
            "description": "Send a message to Claude Code. Use this tool to relay the user's coding requests, questions, or instructions to Claude Code. The message should be clear and complete.",
            "expects_response": true,
            "response_timeout_secs": 120,
            "parameters": {
              "type": "object",
              "required": ["message"],
              "properties": {
                "message": {
                  "type": "string",
                  "description": "The message to send to Claude Code. Should contain the user's complete request or instruction."
                }
              }
            }
          },
          {
            "type": "client",
            "name": "processPermissionRequest",
            "description": "Process a permission request from Claude Code. Use this when the user wants to allow or deny a pending permission request.",
            "expects_response": true,
            "response_timeout_secs": 30,
            "parameters": {
              "type": "object",
              "required": ["decision"],
              "properties": {
                "decision": {
                  "type": "string",
                  "description": "The user's decision: must be either 'allow' or 'deny'"
                }
              }
            }
          }
        ]
      }
    },
    "turn": {
      "turn_timeout": 30.0,
      "silence_end_call_timeout": 600.0
    },
    "tts": {
      "voice_id": "cgSgspJ2msm6clMCkdW9",
      "model_id": "eleven_flash_v2",
      "speed": 1.1
    }
  }
}
EOF
)

if [ -n "$EXISTING_AGENT_ID" ]; then
    echo "Found existing agent: $EXISTING_AGENT_ID"
    echo "Updating agent configuration..."

    RESPONSE=$(curl -s -X PATCH "https://api.elevenlabs.io/v1/convai/agents/$EXISTING_AGENT_ID" \
        -H "xi-api-key: $ELEVENLABS_API_KEY" \
        -H "Content-Type: application/json" \
        -H "Accept: application/json" \
        -d "$AGENT_CONFIG")

    if echo "$RESPONSE" | grep -q '"detail"'; then
        echo "Error updating agent:"
        echo "$RESPONSE" | jq -r '.detail.message // .detail // .'
        exit 1
    fi

    AGENT_ID="$EXISTING_AGENT_ID"
    echo "Agent updated successfully!"
else
    echo "Creating new agent..."

    RESPONSE=$(curl -s -X POST "https://api.elevenlabs.io/v1/convai/agents/create" \
        -H "xi-api-key: $ELEVENLABS_API_KEY" \
        -H "Content-Type: application/json" \
        -H "Accept: application/json" \
        -d "$AGENT_CONFIG")

    if echo "$RESPONSE" | grep -q '"detail"'; then
        echo "Error creating agent:"
        echo "$RESPONSE" | jq -r '.detail.message // .detail // .'
        exit 1
    fi

    AGENT_ID=$(echo "$RESPONSE" | jq -r '.agent_id')

    if [ -z "$AGENT_ID" ] || [ "$AGENT_ID" = "null" ]; then
        echo "Error: Failed to get agent_id from response"
        echo "$RESPONSE"
        exit 1
    fi

    echo "Agent created successfully!"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Agent ID: $AGENT_ID"
echo ""
echo "Add these to your happy-server environment:"
echo ""
echo "  export ELEVENLABS_API_KEY=$ELEVENLABS_API_KEY"
echo "  export ELEVENLABS_AGENT_ID=$AGENT_ID"
echo ""
echo "Or add to your .env file:"
echo ""
echo "  ELEVENLABS_API_KEY=$ELEVENLABS_API_KEY"
echo "  ELEVENLABS_AGENT_ID=$AGENT_ID"
echo ""
