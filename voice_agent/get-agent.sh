#!/bin/bash
#
# Get detailed configuration for an ElevenLabs agent
#
# Usage: ./get-agent.sh <agent_id>
#
# Required environment variable:
#   ELEVENLABS_API_KEY - Your ElevenLabs API key
#

set -e

if [ -z "$ELEVENLABS_API_KEY" ]; then
    echo "Error: ELEVENLABS_API_KEY environment variable is not set"
    exit 1
fi

if [ -z "$1" ]; then
    echo "Usage: ./get-agent.sh <agent_id>"
    echo ""
    echo "Run ./list-agents.sh to see available agent IDs"
    exit 1
fi

AGENT_ID="$1"

echo "Fetching agent $AGENT_ID..."
echo ""

RESPONSE=$(curl -s -X GET "https://api.elevenlabs.io/v1/convai/agents/$AGENT_ID" \
    -H "xi-api-key: $ELEVENLABS_API_KEY" \
    -H "Accept: application/json")

if echo "$RESPONSE" | grep -q '"detail"'; then
    echo "Error from ElevenLabs API:"
    echo "$RESPONSE" | jq -r '.detail.message // .detail // .'
    exit 1
fi

echo "$RESPONSE" | jq .
