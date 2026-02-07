#!/bin/sh
set -e

# Replace build-time placeholders in JS bundles with runtime environment variables
find /usr/share/nginx/html -name '*.js' -exec sed -i \
  -e "s|__RT_ELEVENLABS_AGENT_ID_DEV__|${EXPO_PUBLIC_ELEVENLABS_AGENT_ID_DEV:-}|g" \
  -e "s|__RT_ELEVENLABS_AGENT_ID_PROD__|${EXPO_PUBLIC_ELEVENLABS_AGENT_ID_PROD:-}|g" \
  {} +

exec nginx -g 'daemon off;'
