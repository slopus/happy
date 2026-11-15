#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
src="$root/install-images.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }
g() { grep -F -e "$1" "$src" >/dev/null || fail "missing $1"; }
g 'load_proxy_vars_from_env_file'
g 'prepare_proxy_env'
g 'sync_curl_proxy_env'
g 'shell or .env'
bash -n "$src" || fail "bash -n"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
ENV_FILE="$tmp/.env"

eval "$(awk '
  /^load_proxy_vars_from_env_file\(\) \{/ { p=1 }
  /^sync_curl_proxy_env\(\) \{/ { p=1 }
  /^prepare_proxy_env\(\) \{/ { p=1 }
  p { print }
  p && /^\}/ { if (++c==3) exit }
' "$src")"

unset HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy || true
printf '%s\n' 'HTTP_PROXY="http://fromenv:8080"' 'HTTPS_PROXY=http://fromenv:8443' 'NO_PROXY=localhost' >"$ENV_FILE"
prepare_proxy_env
[[ "$HTTP_PROXY" == "http://fromenv:8080" ]] || fail "HTTP_PROXY from env"
[[ "$http_proxy" == "http://fromenv:8080" ]] || fail "http_proxy synced"
[[ "$HTTPS_PROXY" == "http://fromenv:8443" ]] || fail "HTTPS_PROXY from env"

unset http_proxy || true
HTTP_PROXY='http://shell:9'
printf '%s\n' 'HTTP_PROXY=http://fromenv:1' >"$ENV_FILE"
prepare_proxy_env
[[ "$HTTP_PROXY" == "http://shell:9" ]] || fail "shell should win"
[[ "$http_proxy" == "http://shell:9" ]] || fail "sync from shell"

# Shell uppercase set, lowercase unset; .env has a different lowercase value.
# Family check must skip importing .env so sync copies shell → lowercase.
unset HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy || true
HTTP_PROXY='http://shell-upper:9'
printf '%s\n' 'http_proxy=http://fromenv-lower:1' >"$ENV_FILE"
prepare_proxy_env
[[ "$HTTP_PROXY" == "http://shell-upper:9" ]] || fail "shell HTTP_PROXY should win over .env http_proxy"
[[ "$http_proxy" == "http://shell-upper:9" ]] || fail "http_proxy should sync from shell HTTP_PROXY"
[[ "$http_proxy" != "http://fromenv-lower:1" ]] || fail "must not keep .env http_proxy"

# Reverse: shell lowercase set; .env uppercase must not import either.
unset HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy || true
http_proxy='http://shell-lower:9'
printf '%s\n' 'HTTP_PROXY=http://fromenv-upper:1' >"$ENV_FILE"
prepare_proxy_env
[[ "$http_proxy" == "http://shell-lower:9" ]] || fail "shell http_proxy should win over .env HTTP_PROXY"
[[ -z "${HTTP_PROXY+x}" ]] || fail "must not import .env HTTP_PROXY when http_proxy is set"

# Quoted # in the value must survive comment stripping.
unset HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy || true
printf '%s\n' 'HTTP_PROXY="http://proxy.example/#frag"' 'HTTPS_PROXY='"'"'http://proxy.example/#s'"'"' # trail' >"$ENV_FILE"
prepare_proxy_env
[[ "$HTTP_PROXY" == "http://proxy.example/#frag" ]] || fail "quoted # in double-quoted HTTP_PROXY"
[[ "$HTTPS_PROXY" == "http://proxy.example/#s" ]] || fail "quoted # in single-quoted HTTPS_PROXY"

# Later .env assignments for a family win (same key and cross-case).
unset HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy || true
printf '%s\n' 'HTTP_PROXY=http://first:1' 'HTTP_PROXY=http://second:2' 'http_proxy=http://third:3' >"$ENV_FILE"
prepare_proxy_env
[[ -z "${HTTP_PROXY+x}" ]] || fail "cross-case last win should clear HTTP_PROXY"
[[ "$http_proxy" == "http://third:3" ]] || fail "last .env family assignment should win"

# CRLF .env with quoted values must still unquote (trailing CR must not block it).
unset HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy || true
printf '%s\r\n' 'HTTP_PROXY="http://crlf.example:8080"' 'HTTPS_PROXY='"'"'http://crlf.example:8443'"'" >"$ENV_FILE"
prepare_proxy_env
[[ "$HTTP_PROXY" == "http://crlf.example:8080" ]] || fail "CRLF double-quoted HTTP_PROXY must unquote"
[[ "$HTTPS_PROXY" == "http://crlf.example:8443" ]] || fail "CRLF single-quoted HTTPS_PROXY must unquote"
[[ "$http_proxy" == "http://crlf.example:8080" ]] || fail "CRLF http_proxy sync"

# Escaped \" inside double quotes must not end the value before a literal #.
unset HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy || true
printf '%s\n' 'HTTP_PROXY="http://u:p\"x/#frag" # trail' >"$ENV_FILE"
prepare_proxy_env
[[ "$HTTP_PROXY" == 'http://u:p"x/#frag' ]] || fail "escaped quote must keep # inside double-quoted value"
[[ "$http_proxy" == 'http://u:p"x/#frag' ]] || fail "escaped-quote http_proxy sync"
echo "ok"
