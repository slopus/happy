#!/bin/sh
set -e

# Replace build-time placeholders in JS bundles with runtime environment variables
find /usr/share/nginx/html -name '*.js' -exec sed -i \
  -e "s|__RT_ELEVENLABS_AGENT_ID__|${EXPO_PUBLIC_ELEVENLABS_AGENT_ID:-}|g" \
  -e "s|__RT_HAPPY_SERVER_URL__|${EXPO_PUBLIC_HAPPY_SERVER_URL:-}|g" \
  -e "s|__RT_VOICE_PROVIDER__|${EXPO_PUBLIC_VOICE_PROVIDER:-elevenlabs}|g" \
  -e "s|__RT_VOICE_BASE_URL__|${EXPO_PUBLIC_VOICE_BASE_URL:-}|g" \
  -e "s|__RT_VOICE_TOOL_BRIDGE_BASE_URL__|${EXPO_PUBLIC_VOICE_TOOL_BRIDGE_BASE_URL:-}|g" \
  -e "s|__RT_VOICE_PUBLIC_KEY__|${EXPO_PUBLIC_VOICE_PUBLIC_KEY:-}|g" \
  {} +

exec nginx -g 'daemon off;'
