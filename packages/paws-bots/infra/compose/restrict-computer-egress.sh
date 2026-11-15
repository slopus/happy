#!/usr/bin/env bash
# Restricted egress for Rakazo bot computers (SANDBOX_COMPUTER_EGRESS=restricted).
#
# Computers keep full public-internet egress (browsing, DNS, apt, git over SSH)
# but can no longer reach the destinations below. Docker before 28, and DNS
# servers set for computers or the daemon, forward lookups from the computers'
# own network, so a private resolver there (a VPC or LAN resolver) needs
# SANDBOX_COMPUTER_DNS set to public resolvers (docs/self-host-docker-computers.md).
# Blocked:
#   - the Docker host itself (INPUT drop; replies to host-initiated connections
#     stay open so supervisor control and published screen ports keep working),
#   - RFC1918 / CGNAT / link-local destinations, including cloud metadata at
#     169.254.169.254 (and AWS's IPv6 fd00:ec2::254),
#   - multicast and reserved space.
#
# Rules key on the deterministic bridge names the supervisor assigns in
# restricted mode (rakazo-c<hash>), never on Docker's dynamic subnets — so
# computer churn, network recreate, and subnet reuse need no firewall changes.
#
# Same-bridge peers stay reachable: the supervisor and web screen proxy join the
# computer's bridge. Docker loads br_netfilter with bridge-nf-call-iptables, so
# same-bridge frames DO traverse FORWARD/DOCKER-USER — the first rule below
# returns traffic whose in- and out-interface are the same bridge family before
# any drop applies. On hosts where bridged frames skip iptables entirely, that
# rule is simply never matched.
#
# Requires Linux Docker Engine with the iptables firewall backend (the
# DOCKER-USER chain). Docker Desktop, rootless Docker, and the nftables
# backend are not supported.
#
#   sudo bash restrict-computer-egress.sh          # apply now + persist via systemd
#   bash restrict-computer-egress.sh --print       # show the rules, change nothing
#   sudo bash restrict-computer-egress.sh --remove # uninstall

set -Eeuo pipefail

IPTABLES="${RAKAZO_IPTABLES:-iptables}"
IP6TABLES="${RAKAZO_IP6TABLES:-ip6tables}"
SYSTEMCTL="${RAKAZO_SYSTEMCTL:-systemctl}"
IF_INET6="${RAKAZO_IF_INET6:-/proc/net/if_inet6}"
BRIDGE_PREFIX="rakazo-c"
INSTALLED_PATH=/usr/local/sbin/rakazo-computer-egress
UNIT_PATH=/etc/systemd/system/rakazo-computer-egress.service

usage() {
  cat <<'EOF'
Usage: restrict-computer-egress.sh [--install|--apply|--remove|--print]
  (default)   apply the rules now and persist them across reboots via systemd
  --apply     apply the rules now only (used by the systemd unit)
  --remove    delete the rules and the systemd unit
  --print     show the iptables commands without changing anything
EOF
}

# Forwarded destinations a computer may never reach: every non-public IPv4 block.
blocked_destinations_v4() {
  cat <<'EOF'
0.0.0.0/8
10.0.0.0/8
100.64.0.0/10
127.0.0.0/8
169.254.0.0/16
172.16.0.0/12
192.0.0.0/24
192.168.0.0/16
198.18.0.0/15
224.0.0.0/4
240.0.0.0/4
EOF
}

blocked_destinations_v6() {
  cat <<'EOF'
::1/128
fc00::/7
fe80::/10
ff00::/8
EOF
}

# One rule per line: "<chain> <args>". Order matters: same-bridge traffic
# (-i and -o both rakazo-c*) must be returned to Docker's own chains before the
# destination drops, and in INPUT the established accept must precede the
# catch-all drop so host- and supervisor-initiated connections to the computer
# (control endpoint, published screen port) keep working while the computer can
# no longer open connections to the host.
#
# INPUT is listed first so it is inserted last (rules go in by a reverse pass).
# The supervisor's start-up probe detects the INPUT drop, so its presence must
# mean the DOCKER-USER destination drops of the same run are already in place.
egress_rules_v4() {
  local cidr
  printf 'INPUT -i %s+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT\n' "$BRIDGE_PREFIX"
  printf 'INPUT -i %s+ -j DROP\n' "$BRIDGE_PREFIX"
  printf 'DOCKER-USER -i %s+ -o %s+ -j RETURN\n' "$BRIDGE_PREFIX" "$BRIDGE_PREFIX"
  while IFS= read -r cidr; do
    printf 'DOCKER-USER -i %s+ -d %s -j DROP\n' "$BRIDGE_PREFIX" "$cidr"
  done < <(blocked_destinations_v4)
}

egress_rules_v6() {
  local cidr
  printf 'INPUT -i %s+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT\n' "$BRIDGE_PREFIX"
  printf 'INPUT -i %s+ -j DROP\n' "$BRIDGE_PREFIX"
  printf 'DOCKER-USER -i %s+ -o %s+ -j RETURN\n' "$BRIDGE_PREFIX" "$BRIDGE_PREFIX"
  while IFS= read -r cidr; do
    printf 'DOCKER-USER -i %s+ -d %s -j DROP\n' "$BRIDGE_PREFIX" "$cidr"
  done < <(blocked_destinations_v6)
}

wait_for_docker_user() {
  local cmd="$1" deadline=$((SECONDS + 30))
  until "$cmd" -L DOCKER-USER -n >/dev/null 2>&1; do
    if ((SECONDS > deadline)); then
      echo "DOCKER-USER chain not present — is Docker running with the iptables backend?" >&2
      return 1
    fi
    sleep 1
  done
}

# Canonical form so iptables -S reordering (-d before -i, ctstate sorted) still
# matches the spec. Every other token (protocol, ports, source, match modules)
# stays in the identity, so a narrower rule is not treated as a managed copy.
normalize_rule() {
  local spec="$1"
  local -a toks
  read -ra toks <<<"$spec"
  local in="" out="" dest="" jump="" ct="" extra="" i=0
  while ((i < ${#toks[@]})); do
    case "${toks[i]}" in
      -i) in="${toks[i + 1]:-}"; i=$((i + 2)) ;;
      -o) out="${toks[i + 1]:-}"; i=$((i + 2)) ;;
      -d) dest="${toks[i + 1]:-}"; i=$((i + 2)) ;;
      -j) jump="${toks[i + 1]:-}"; i=$((i + 2)) ;;
      --ctstate) ct="${toks[i + 1]:-}"; i=$((i + 2)) ;;
      *) extra+="${toks[i]} "; i=$((i + 1)) ;;
    esac
  done
  if [[ -n $ct ]]; then
    ct="$(printf '%s\n' "$ct" | tr ',' '\n' | LC_ALL=C sort | paste -sd, -)"
  fi
  printf 'in=%s out=%s dest=%s ct=%s jump=%s extra=%s' \
    "$in" "$out" "$dest" "$ct" "$jump" "${extra%" "}"
}

# True when this chain already begins with the managed rules, in order, above
# anything an operator or another firewall manager inserted later.
chain_has_prefix() {
  local cmd="$1" chain="$2"
  shift 2
  local -a wanted=("$@") current=()
  local line
  while IFS= read -r line; do
    [[ "$line" == "-A $chain "* ]] || continue
    current+=("${line#-A $chain }")
  done < <("$cmd" -S "$chain" 2>/dev/null || true)
  ((${#current[@]} >= ${#wanted[@]})) || return 1
  local i
  for ((i = 0; i < ${#wanted[@]}; i++)); do
    [[ "$(normalize_rule "${current[i]}")" == "$(normalize_rule "${wanted[i]}")" ]] || return 1
  done
}

# Rules below a managed prefix that duplicate it. The prefix itself is kept:
# replacements are inserted at the head first, and only later copies are removed.
delete_stale_below_prefix() {
  local cmd="$1" chain="$2"
  shift 2
  local -a wanted=("$@") lines=() stale=()
  local line i j norm prefix_len=${#wanted[@]}
  while IFS= read -r line; do
    [[ "$line" == "-A $chain "* ]] || continue
    lines+=("${line#-A "$chain" }")
  done < <("$cmd" -S "$chain" 2>/dev/null || true)
  for ((i = prefix_len; i < ${#lines[@]}; i++)); do
    norm="$(normalize_rule "${lines[i]}")"
    for ((j = 0; j < prefix_len; j++)); do
      if [[ "$norm" == "$(normalize_rule "${wanted[j]}")" ]]; then
        stale+=("$((i + 1))")
        break
      fi
    done
  done
  # Highest number first so each delete leaves the remaining numbers valid.
  for ((i = ${#stale[@]} - 1; i >= 0; i--)); do
    "$cmd" -D "$chain" "${stale[i]}"
  done
}

# Insert each chain's rules at its head so a broader accept cannot shadow the
# drops. Same-bridge RETURN stays above the drops, and the INPUT established
# accept stays above the catch-all drop. A chain that already has that prefix
# is left alone.
apply_family() {
  local cmd="$1" rules=() line chain
  command -v "$cmd" >/dev/null 2>&1 || return 0
  wait_for_docker_user "$cmd"
  while IFS= read -r line; do rules+=("$line"); done < <("$2")
  local -a chain_names=()
  local seen=" "
  for line in "${rules[@]}"; do
    chain="${line%% *}"
    if [[ "$seen" != *" $chain "* ]]; then
      seen+="$chain "
      chain_names+=("$chain")
    fi
  done
  local rewrite=" "
  local chain_needs=0
  for chain in "${chain_names[@]}"; do
    local -a wanted=()
    for line in "${rules[@]}"; do
      [[ "${line%% *}" == "$chain" ]] || continue
      wanted+=("${line#* }")
    done
    if chain_has_prefix "$cmd" "$chain" "${wanted[@]}"; then
      continue
    fi
    rewrite+="$chain "
    chain_needs=1
  done
  if ((chain_needs == 0)); then
    return 0
  fi
  # Insert the new prefix before deleting the copies it replaces. Deleting
  # first would drop enforcement if a later iptables command failed or the
  # script were interrupted. Stale copies are removed only once the new rules
  # are already at the head, and by number so those new rules stay.
  # One reverse pass matches --print and real per-chain inserts: each -I 1
  # leaves the documented order at the head (RETURN above drops, established
  # accept above the INPUT drop).
  local i
  local -a args wanted=()
  for ((i = ${#rules[@]} - 1; i >= 0; i--)); do
    line="${rules[i]}"
    chain="${line%% *}"
    [[ "$rewrite" == *" $chain "* ]] || continue
    read -ra args <<<"${line#* }"
    "$cmd" -I "$chain" 1 "${args[@]}"
  done
  for chain in "${chain_names[@]}"; do
    [[ "$rewrite" == *" $chain "* ]] || continue
    wanted=()
    for line in "${rules[@]}"; do
      [[ "${line%% *}" == "$chain" ]] || continue
      wanted+=("${line#* }")
    done
    delete_stale_below_prefix "$cmd" "$chain" "${wanted[@]}"
  done
}

remove_family() {
  local cmd="$1" line
  command -v "$cmd" >/dev/null 2>&1 || return 0
  while IFS= read -r line; do
    local -a args
    read -ra args <<<"$line"
    while "$cmd" -C "${args[@]}" 2>/dev/null; do
      "$cmd" -D "${args[@]}"
    done
  done < <("$2")
}

apply_rules() {
  # Missing IPv4 iptables must be loud: otherwise this prints success having
  # installed nothing (e.g. hosts on the nftables backend without the shim).
  if ! command -v "$IPTABLES" >/dev/null 2>&1; then
    echo "$IPTABLES not found — restricted egress needs the iptables firewall backend." >&2
    exit 1
  fi
  apply_family "$IPTABLES" egress_rules_v4
  if ! command -v "$IP6TABLES" >/dev/null 2>&1; then
    if host_has_ipv6; then
      echo "$IP6TABLES not found but the host has global IPv6 — computers would" >&2
      echo "keep unrestricted IPv6 egress. Install ip6tables or disable IPv6." >&2
      exit 1
    fi
  elif "$IP6TABLES" -L DOCKER-USER -n >/dev/null 2>&1 ||
    { host_has_ipv6 && wait_for_docker_user "$IP6TABLES"; }; then
    # The chain can lag dockerd startup; on dual-stack hosts it gets the same
    # grace window apply_family gives IPv4 before we reject the host.
    apply_family "$IP6TABLES" egress_rules_v6
  elif host_has_ipv6; then
    echo "$IP6TABLES DOCKER-USER is unavailable but the host has global IPv6 —" >&2
    echo "computers would keep unrestricted IPv6 egress. Start Docker first (it" >&2
    echo "creates the chain) or disable IPv6, then re-run." >&2
    exit 1
  fi
}

# Scope-00 (global) entries in if_inet6 mean the host routes IPv6.
host_has_ipv6() {
  [[ -f $IF_INET6 ]] && awk '$4 == "00" { found = 1 } END { exit !found }' "$IF_INET6"
}

# Emit the commands --apply runs, in execution order: every rule inserts at the
# top of its chain, so the documented order prints in reverse. Pasting the
# output verbatim reproduces the intended chain.
print_family() {
  local cmd="$1" rules=() line i
  command -v "$cmd" >/dev/null 2>&1 || return 0
  while IFS= read -r line; do rules+=("$line"); done < <("$2")
  for ((i = ${#rules[@]} - 1; i >= 0; i--)); do
    line="${rules[i]}"
    printf '%s -I %s 1 %s\n' "$cmd" "${line%% *}" "${line#* }"
  done
}

require_root() {
  if ((EUID == 0)); then return 0; fi
  if [[ "${RAKAZO_EGRESS_SUDOED:-}" == "1" ]]; then
    echo "root privileges required" >&2
    exit 1
  fi
  export RAKAZO_EGRESS_SUDOED=1
  exec sudo --preserve-env=RAKAZO_EGRESS_SUDOED bash "$0" "$@"
}

install_persistence() {
  if ! command -v "$SYSTEMCTL" >/dev/null 2>&1; then
    echo "systemd not found; rules apply until reboot — re-run this script after one." >&2
    return 0
  fi
  if [[ "$0" == "bash" || "$0" == "-bash" || ! -f "$0" ]]; then
    echo "Run from a saved file to enable reboot persistence; rules were applied anyway." >&2
    return 0
  fi
  if [[ "$(readlink -f "$0")" != "$INSTALLED_PATH" ]]; then
    install -m 0755 "$0" "$INSTALLED_PATH"
  fi
  cat >"$UNIT_PATH" <<EOF
[Unit]
Description=Restrict Rakazo bot-computer egress (rakazo-c* bridges)
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$INSTALLED_PATH --apply

[Install]
WantedBy=multi-user.target
EOF
  "$SYSTEMCTL" daemon-reload
  "$SYSTEMCTL" enable rakazo-computer-egress.service
}

remove_persistence() {
  if command -v "$SYSTEMCTL" >/dev/null 2>&1 && [[ -f "$UNIT_PATH" ]]; then
    "$SYSTEMCTL" disable --now rakazo-computer-egress.service || true
    rm -f "$UNIT_PATH"
    "$SYSTEMCTL" daemon-reload
  fi
  rm -f "$INSTALLED_PATH"
}

mode="${1:---install}"
case "$mode" in
  --install)
    require_root "$@"
    apply_rules
    install_persistence
    echo "Computer egress restricted: rakazo-c* bridges drop non-public and host-bound traffic."
    ;;
  --apply)
    apply_rules
    ;;
  --remove)
    require_root "$@"
    remove_family "$IPTABLES" egress_rules_v4
    remove_family "$IP6TABLES" egress_rules_v6
    remove_persistence
    echo "Computer egress rules and persistence removed."
    ;;
  --print)
    print_family "$IPTABLES" egress_rules_v4
    print_family "$IP6TABLES" egress_rules_v6
    ;;
  -h | --help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
