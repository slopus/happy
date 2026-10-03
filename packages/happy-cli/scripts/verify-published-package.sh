#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-aplus\.[0-9]+$ ]]; then
    echo 'Expected an exact A+ CLI release version' >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
export npm_config_cache="$WORK_DIR/cache"
export npm_config_registry='https://registry.npmjs.org'
PACKAGE="@buzzni/happy-cli@$VERSION"
AVAILABLE=false
for attempt in {1..60}; do
    TARBALL_URL="$(npm view "$PACKAGE" dist.tarball --prefer-online 2>/dev/null || true)"
    if [[ -n "$TARBALL_URL" ]] && curl -fsI --max-time 30 "$TARBALL_URL" >/dev/null; then
        AVAILABLE=true
        break
    fi
    echo "Waiting for registry propagation ($attempt/60): $PACKAGE"
    if [[ "$attempt" -lt 60 ]]; then sleep 30; fi
done
if [[ "$AVAILABLE" != true ]]; then
    echo "Published package is not available: $PACKAGE" >&2
    exit 1
fi

npm pack "$PACKAGE" --ignore-scripts --json --prefer-online --pack-destination "$WORK_DIR" > "$WORK_DIR/pack.json"
TARBALL_NAME="$(node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const packed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (packed.length !== 1 || packed[0].name !== "@buzzni/happy-cli" || packed[0].version !== process.argv[2]
        || typeof packed[0].filename !== "string" || path.basename(packed[0].filename) !== packed[0].filename) {
        throw new Error("Packed release does not match the requested version");
    }
    process.stdout.write(packed[0].filename);
' "$WORK_DIR/pack.json" "$VERSION")"
node "$SCRIPT_DIR/guard-publish-artifact.cjs" "$WORK_DIR/$TARBALL_NAME" --install-smoke
