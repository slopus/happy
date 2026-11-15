#!/usr/bin/env bash
# Offline checks for install-images.sh's computer egress setup: stubbed uname,
# docker, iptables and egress script; no daemon, root or firewall changes.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
src="$root/install-images.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/install-egress-smoke.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

# $1 work dir, $2 uname, $3 docker OperatingSystem, $4 install iptables stub (1/0),
# $5 egress script exit code, $6 extra .env line.
# $7 omit the local egress script (1/0).
run_case() {
  local work="$tmp/$1"
  mkdir -p "$work/bin" "$work/cwd"
  printf '#!/usr/bin/env bash\necho %s\n' "$2" >"$work/bin/uname"
  cat >"$work/bin/docker" <<STUB
#!/usr/bin/env bash
if [[ "\$1" == info ]]; then
  case "\$*" in
    *OperatingSystem*) echo "$3" ;;
    *) echo '["name=seccomp"]' ;;
  esac
  exit 0
fi
[[ " \$* " == *" config "* ]] && cat >/dev/null && cat <<'EOF'
POSTGRES_PASSWORD=p
POSTGRES_APP_PASSWORD=a
BETTER_AUTH_SECRET=b
ENCRYPTION_KEY=e
SCREEN_PROXY_SECRET=s
SANDBOX_SUPERVISOR_TOKEN=t
EOF
exit 0
STUB
  if [[ "$4" == 1 ]]; then printf '#!/usr/bin/env bash\nexit 0\n' >"$work/bin/iptables"; fi
  if [[ "${7:-0}" != 1 ]]; then
    printf '#!/usr/bin/env bash\necho ran >>"%s/script.log"\nexit %s\n' "$work" "$5" \
      >"$work/cwd/restrict-computer-egress.sh"
  else
    printf '#!/usr/bin/env bash\necho called >>"%s/curl.log"\nexit 1\n' "$work" \
      >"$work/bin/curl"
  fi
  chmod +x "$work/bin/"*
  : >"$work/cwd/docker-compose.images.yml"
  : >"$work/cwd/.env.images.example"
  printf 'POSTGRES_PASSWORD=p\nPOSTGRES_APP_PASSWORD=a\n%s\n' "$6" >"$work/cwd/.env"
  # Keep installer dependencies without exposing the host's iptables or curl.
  local command_name command_path
  for command_name in bash env cat grep awk sed sort openssl mktemp mv rm tail; do
    command_path="$(command -v "$command_name")" || fail "fixture requires $command_name"
    ln -s "$command_path" "$work/bin/$command_name"
  done
  (
    cd "$work/cwd"
    unset SANDBOX_COMPUTER_EGRESS
    PATH="$work/bin" "$work/bin/bash" "$src" --offline
  ) >"$work/out.log" 2>&1 || fail "$1: installer exited non-zero: $(cat "$work/out.log")"
}

egress_of() { grep -E '^SANDBOX_COMPUTER_EGRESS=' "$tmp/$1/cwd/.env" | tail -1 | cut -d= -f2; }
script_ran() { [[ -s "$tmp/$1/script.log" ]]; }

run_case linux Linux "Ubuntu 24.04 LTS" 1 0 ""
[[ "$(egress_of linux)" == restricted ]] || fail "Linux Engine should record restricted"
script_ran linux || fail "Linux Engine should run the egress script"

run_case rules-fail Linux "Ubuntu 24.04 LTS" 1 1 ""
[[ "$(egress_of rules-fail)" == open ]] || fail "failed rules should fall back to open"
grep -q 'could not be installed' "$tmp/rules-fail/out.log" || fail "fallback must say why"

run_case macos Darwin "Docker Desktop" 1 0 ""
[[ "$(egress_of macos)" == open ]] || fail "macOS should record open"
script_ran macos && fail "macOS must not run the egress script"
grep -q 'Warning: bot computers can reach' "$tmp/macos/out.log" || fail "macOS must warn"

run_case desktop-linux Linux "Docker Desktop" 1 0 ""
[[ "$(egress_of desktop-linux)" == open ]] || fail "Docker Desktop on Linux should record open"
script_ran desktop-linux && fail "Docker Desktop must not run the egress script"

run_case no-iptables Linux "Debian GNU/Linux 12" 0 0 ""
[[ "$(egress_of no-iptables)" == open ]] || fail "missing iptables should record open"

script_ran no-iptables && fail "missing iptables must not run the egress script"
grep -q 'iptables is not installed' "$tmp/no-iptables/out.log" ||
  fail "missing iptables must reach the unsupported-host fallback"

run_case missing-script Linux "Ubuntu 24.04 LTS" 1 0 "" 1
[[ "$(egress_of missing-script)" == open ]] || fail "missing offline script should record open"
script_ran missing-script && fail "missing offline script must not run"
[[ ! -s "$tmp/missing-script/curl.log" ]] || fail "--offline must not download the optional egress script"
grep -q 'restrict-computer-egress.sh' "$tmp/missing-script/out.log" ||
  fail "missing offline script must explain the fallback"

run_case operator-set Linux "Ubuntu 24.04 LTS" 1 0 "SANDBOX_COMPUTER_EGRESS=open"
[[ "$(grep -c '^SANDBOX_COMPUTER_EGRESS=' "$tmp/operator-set/cwd/.env")" == 1 ]] ||
  fail "an operator's value must be kept"
script_ran operator-set && fail "an operator's value must skip the egress script"

echo "install-images egress smoke checks passed."
