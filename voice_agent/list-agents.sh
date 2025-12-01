#!/bin/bash
#
# List all ElevenLabs Conversational AI agents
#
# Usage: ./list-agents.sh
#
# Required environment variable:
#   ELEVENLABS_API_KEY - Your ElevenLabs API key
#

set -e

if [ -z "$ELEVENLABS_API_KEY" ]; then
    echo "Error: ELEVENLABS_API_KEY environment variable is not set"
    exit 1
fi

echo "Fetching agents..."
echo ""

RESPONSE=$(curl -s -X GET "https://api.elevenlabs.io/v1/convai/agents" \
    -H "xi-api-key: $ELEVENLABS_API_KEY" \
    -H "Accept: application/json")

if echo "$RESPONSE" | grep -q '"detail"'; then
    echo "Error from ElevenLabs API:"
    echo "$RESPONSE" | jq -r '.detail.message // .detail // .'
    exit 1
fi

AGENT_COUNT=$(echo "$RESPONSE" | jq '.agents | length')

if [ "$AGENT_COUNT" = "0" ]; then
    echo "No agents found."
    exit 0
fi

echo "Found $AGENT_COUNT agent(s):"
echo ""

echo "$RESPONSE" | jq -r '.agents[] | "  Name: \(.name)\n  ID:   \(.agent_id)\n"'
