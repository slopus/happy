#!/bin/bash
# Copies the Gen UI spec's shared files from a happy-agent checkout into the
# app: compiled render examples as the debug fixtures, the conformance cases
# the tests run, and theme.json / catalog.json beside theme.py.
#
#   tools/genui/sync.sh <happy-agent checkout>
#
# Then run tools/genui/theme.py if theme.json changed.
set -e
SPEC=${1:?happy-agent checkout}/docs/genui
HERE=$(cd "$(dirname "$0")" && pwd)
APP=$HERE/../../app/src
for f in "$SPEC"/render/compiled/*.render.json; do
  cp "$f" "$APP/debug/assets/genui/fixtures/$(basename "$f" .render.json).json"
done
cp "$SPEC/render/examples/icons-and-colours.render.json" "$APP/debug/assets/genui/fixtures/icons-and-colours.json"
mkdir -p "$APP/test/resources/genui/conformance"
cp "$SPEC"/render/conformance/*.json "$APP/test/resources/genui/conformance/"
cp "$SPEC/theme.json" "$HERE/theme.json"
cp "$SPEC/render/catalog.json" "$HERE/catalog.json"
echo "synced from $(git -C "$SPEC" rev-parse --short HEAD 2>/dev/null || echo "$SPEC")"
