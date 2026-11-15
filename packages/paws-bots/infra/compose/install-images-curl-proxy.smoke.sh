#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
src="$root/install-images.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }
g() { grep -F -e "$1" "$src" >/dev/null || fail "missing $1"; }
g 'sync_curl_proxy_env'
g 'export http_proxy="$HTTP_PROXY"'
g 'export https_proxy="$HTTPS_PROXY"'
g 'export no_proxy="$NO_PROXY"'
g 'could not pull images'
g 'registry-mirrors'
g 'Set HTTP_PROXY/HTTPS_PROXY'
g 'NO_PROXY for localhost'
g '--pull never'
bash -n "$src" || fail "bash -n"

# Unit: source only the sync function
eval "$(awk '
  /^sync_curl_proxy_env\(\) \{/ { p=1 }
  p { print }
  p && /^\}/ { exit }
' "$src")"
unset http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY || true
HTTP_PROXY='http://proxy.example:8080'
HTTPS_PROXY='http://proxy.example:8443'
NO_PROXY='localhost,127.0.0.1'
sync_curl_proxy_env
[[ "$http_proxy" == "$HTTP_PROXY" ]] || fail "http_proxy not synced"
[[ "$https_proxy" == "$HTTPS_PROXY" ]] || fail "https_proxy not synced"
[[ "$no_proxy" == "$NO_PROXY" ]] || fail "no_proxy not synced"
# do not clobber explicit lowercase
http_proxy='http://already:1'
HTTP_PROXY='http://upper:1'
sync_curl_proxy_env
[[ "$http_proxy" == 'http://already:1' ]] || fail "clobbered existing http_proxy"
# exported-but-empty lowercase means no proxy; do not overwrite from uppercase
unset http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY || true
export http_proxy=""
export https_proxy=""
export no_proxy=""
HTTP_PROXY='http://upper:1'
HTTPS_PROXY='http://upper:2'
NO_PROXY='upper.example'
sync_curl_proxy_env
[[ -n "${http_proxy+x}" && -z "$http_proxy" ]] || fail "empty http_proxy overwritten"
[[ -n "${https_proxy+x}" && -z "$https_proxy" ]] || fail "empty https_proxy overwritten"
[[ -n "${no_proxy+x}" && -z "$no_proxy" ]] || fail "empty no_proxy overwritten"
echo "ok"
