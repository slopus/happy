#!/bin/bash
#
# Delete an ElevenLabs Conversational AI agent
#
# Usage: ./delete-agent.sh <agent_id>
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
    echo "Usage: ./delete-agent.sh <agent_id>"
    echo ""
    echo "Run ./list-agents.sh to see available agent IDs"
    exit 1
fi

AGENT_ID="$1"

echo "Are you sure you want to delete agent $AGENT_ID? [y/N]"
read -r CONFIRM

if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    echo "Aborted."
    exit 0
fi

echo "Deleting agent $AGENT_ID..."

RESPONSE=$(curl -s -w "\n%{http_code}" -X DELETE "https://api.elevenlabs.io/v1/convai/agents/$AGENT_ID" \
    -H "xi-api-key: $ELEVENLABS_API_KEY" \
    -H "Accept: application/json")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "204" ]; then
    echo "Agent deleted successfully."
else
    echo "Error deleting agent (HTTP $HTTP_CODE):"
    echo "$BODY" | jq -r '.detail.message // .detail // .' 2>/dev/null || echo "$BODY"
    exit 1
fi
