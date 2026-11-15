#!/usr/bin/env bash
# Offline checks for restrict-computer-egress.sh; stubbed iptables, no daemon or root.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
script="$root/restrict-computer-egress.sh"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

bash -n "$script"

print_bin="$scratch/print-bin"
mkdir -p "$print_bin"
for tool in iptables ip6tables; do
  printf '#!/usr/bin/env bash\nexit 99\n' >"$print_bin/$tool"
  chmod +x "$print_bin/$tool"
done
printed="$(PATH="$print_bin:$PATH" bash "$script" --print)"
[[ -n "$printed" ]] || fail "--print produced no rules"

# --print emits execution order (each rule inserts at the top of its chain), so
# the same-bridge RETURN — which must END UP first in DOCKER-USER — prints last
# among the IPv4 DOCKER-USER rules. Same-bridge traffic (supervisor/web peers
# under br_netfilter, where bridged frames traverse FORWARD) is returned to
# Docker's own chains before any drop.
last_v4_user="$(grep '^iptables -I DOCKER-USER' <<<"$printed" | tail -1)"
[[ "$last_v4_user" == 'iptables -I DOCKER-USER 1 -i rakazo-c+ -o rakazo-c+ -j RETURN' ]] ||
  fail "same-bridge RETURN must print last among IPv4 DOCKER-USER rules"
grep -qxF 'ip6tables -I DOCKER-USER 1 -i rakazo-c+ -o rakazo-c+ -j RETURN' <<<"$printed" ||
  fail "missing IPv6 same-bridge RETURN"

# Every non-public IPv4 block is dropped on the computer bridges' forwarded path.
for cidr in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 \
  172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
  grep -qxF "iptables -I DOCKER-USER 1 -i rakazo-c+ -d $cidr -j DROP" <<<"$printed" ||
    fail "missing DOCKER-USER drop for $cidr"
done

# Host input: the catch-all drop executes before the established-accept so the
# accept ends up above it (host/supervisor-initiated control and screen
# connections keep working while the computer cannot open connections out).
drop_i="$(grep -nx 'iptables -I INPUT 1 -i rakazo-c+ -j DROP' <<<"$printed" | head -1 | cut -d: -f1)"
est_i="$(grep -nx 'iptables -I INPUT 1 -i rakazo-c+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT' <<<"$printed" | head -1 | cut -d: -f1)"
[[ -n "$drop_i" && -n "$est_i" && "$drop_i" -lt "$est_i" ]] ||
  fail "--print must emit the INPUT drop before the established accept"

# The supervisor's probe detects the INPUT drop, so the IPv4 run installs it only
# after every IPv4 DOCKER-USER drop.
last_user_i="$(grep -n '^iptables -I DOCKER-USER' <<<"$printed" | tail -1 | cut -d: -f1)"
[[ -n "$last_user_i" && "$last_user_i" -lt "$drop_i" ]] ||
  fail "the IPv4 INPUT rules must be inserted after the DOCKER-USER drops"

# IPv6 drops ULA (includes AWS metadata fd00:ec2::254), link-local, multicast, loopback.
for cidr in ::1/128 fc00::/7 fe80::/10 ff00::/8; do
  grep -qxF "ip6tables -I DOCKER-USER 1 -i rakazo-c+ -d $cidr -j DROP" <<<"$printed" ||
    fail "missing IPv6 drop for $cidr"
done

# --apply with stubbed firewall commands: installs each rule once, idempotently,
# inserting in reverse so the printed order lands at the top of each chain.
bin="$scratch/bin"
mkdir -p "$bin"
export STUB_DIR="$scratch/state"
mkdir -p "$STUB_DIR"
for tool in iptables ip6tables; do
  cat >"$bin/$tool" <<'STUB'
#!/usr/bin/env bash
state="$STUB_DIR/$(basename "$0").state"
printf '%s\n' "$*" >>"$STUB_DIR/$(basename "$0").calls"
op="$1"; shift || true

# iptables -S prints -d before -i and may swap ctstate flag order. The script
# must still recognize its own rules in that form.
canonicalize() {
  local chain="${1%% *}" rest="${1#* }"
  [[ "$chain" == "$rest" ]] && { printf '%s\n' "$1"; return; }
  local -a toks kept=()
  local dest="" i=0
  read -ra toks <<<"$rest"
  while ((i < ${#toks[@]})); do
    if [[ ${toks[i]} == "-d" && -n ${toks[i + 1]:-} ]]; then
      dest="${toks[i + 1]}"
      i=$((i + 2))
    elif [[ ${toks[i]} == "--ctstate" && ${toks[i + 1]:-} == "ESTABLISHED,RELATED" ]]; then
      kept+=("--ctstate" "RELATED,ESTABLISHED")
      i=$((i + 2))
    else
      kept+=("${toks[i]}")
      i=$((i + 1))
    fi
  done
  if [[ -n $dest ]]; then
    if ((${#kept[@]} > 0)); then
      printf '%s -d %s %s\n' "$chain" "$dest" "${kept[*]}"
    else
      printf '%s -d %s\n' "$chain" "$dest"
    fi
  else
    printf '%s %s\n' "$chain" "${kept[*]}"
  fi
}

# Exit before the Nth mutating command (--apply repair test). State is unchanged
# by the command that fails.
fail_midway() {
  [[ -n ${STUB_FAIL_ON_MUTATION:-} ]] || return 0
  local count_file="$STUB_DIR/mutation.count" count=0
  [[ -f $count_file ]] && count="$(<"$count_file")"
  count=$((count + 1))
  printf '%s\n' "$count" >"$count_file"
  if ((count == STUB_FAIL_ON_MUTATION)); then
    echo "simulated iptables failure" >&2
    exit 1
  fi
}

case "$op" in
  -L) exit 0 ;;
  -S)
    chain="$1"
    printf '%s\n' "-N $chain"
    if [[ -f $state ]]; then
      while IFS= read -r row; do
        [[ "$row" == "$chain "* ]] || continue
        printf '%s\n' "-A $(canonicalize "$row")"
      done <"$state"
    fi
    ;;
  -C) grep -qxF -- "$*" "$state" 2>/dev/null ;;
  # -I CHAIN 1 inserts at the top: model it as a prepend so the state file
  # mirrors real chain order (top to bottom).
  -I) fail_midway
      chain="$1"; shift 2 || true
      { printf '%s %s\n' "$chain" "$*"; cat "$state" 2>/dev/null; } >"$state.tmp"
      mv "$state.tmp" "$state" ;;
  # -D CHAIN N removes one rule by number. -D CHAIN spec removes every match
  # (used by --remove).
  -D) fail_midway
      chain="$1"; shift || true
      if [[ "${1:-}" =~ ^[0-9]+$ && $# -eq 1 ]]; then
        n="$1"
        awk -v chain="$chain" -v n="$n" '
          $1 == chain { c++; if (c == n) next }
          { print }
        ' "$state" >"$state.tmp"
        mv "$state.tmp" "$state"
      else
        grep -vxF -- "$chain $*" "$state" >"$state.tmp" 2>/dev/null || true
        mv "$state.tmp" "$state"
      fi
      ;;
esac
STUB
  chmod +x "$bin/$tool"
done

RAKAZO_IPTABLES="$bin/iptables" RAKAZO_IP6TABLES="$bin/ip6tables" bash "$script" --apply
v4_state="$STUB_DIR/iptables.state"
v6_state="$STUB_DIR/ip6tables.state"
v4_calls="$STUB_DIR/iptables.calls"

[[ "$(wc -l <"$v4_state")" -eq 14 ]] || fail "expected 14 IPv4 rules, got $(wc -l <"$v4_state")"
[[ "$(wc -l <"$v6_state")" -eq 7 ]] || fail "expected 7 IPv6 rules, got $(wc -l <"$v6_state")"
grep -qxF 'INPUT -i rakazo-c+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT' "$v4_state" ||
  fail "established accept missing after apply"
grep -qxF 'INPUT -i rakazo-c+ -j DROP' "$v4_state" || fail "INPUT drop missing after apply"
grep -qxF 'DOCKER-USER -i rakazo-c+ -d 169.254.0.0/16 -j DROP' "$v4_state" ||
  fail "metadata drop missing after apply"
grep -qxF 'DOCKER-USER -i rakazo-c+ -o rakazo-c+ -j RETURN' "$v4_state" ||
  fail "same-bridge RETURN missing after apply"

# The established accept must end up above the INPUT drop. Call order is not
# the chain: a prefix check may probe the accept before the drop is inserted.
acc_at="$(grep -nxF 'INPUT -i rakazo-c+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT' "$v4_state" | head -1 | cut -d: -f1)"
drop_at="$(grep -nxF 'INPUT -i rakazo-c+ -j DROP' "$v4_state" | head -1 | cut -d: -f1)"
[[ -n "$acc_at" && -n "$drop_at" && "$acc_at" -lt "$drop_at" ]] ||
  fail "established accept must sit above the INPUT drop"

# Second apply inserts nothing when the managed rules are already the prefix.
# The stub's -S output has already moved -d ahead of -i and swapped ctstate.
RAKAZO_IPTABLES="$bin/iptables" RAKAZO_IP6TABLES="$bin/ip6tables" bash "$script" --apply
[[ "$(grep -c '^-I ' "$v4_calls")" == 14 ]] ||
  fail "rules re-inserted on repeat apply"
[[ "$(grep -c '^-I ' "$STUB_DIR/ip6tables.calls")" == 7 ]] ||
  fail "IPv6 rules re-inserted on repeat apply"

# Later repair checks expect this exact prefix.
cp "$v4_state" "$scratch/v4.clean"

# Same interface and destination with a different target is not the managed
# drop. --apply must install the drop and leave the foreign accept in place.
sed 's/DOCKER-USER -i rakazo-c+ -d 169.254.0.0\/16 -j DROP/DOCKER-USER -i rakazo-c+ -d 169.254.0.0\/16 -j ACCEPT/' \
  "$scratch/v4.clean" >"$v4_state"
RAKAZO_IPTABLES="$bin/iptables" RAKAZO_IP6TABLES="$bin/ip6tables" bash "$script" --apply
grep -qxF 'DOCKER-USER -i rakazo-c+ -d 169.254.0.0/16 -j DROP' "$v4_state" ||
  fail "metadata drop not restored when an accept occupied its slot"
grep -qxF 'DOCKER-USER -i rakazo-c+ -d 169.254.0.0/16 -j ACCEPT' "$v4_state" ||
  fail "foreign accept for the metadata destination was deleted"
meta_drop_at="$(grep -nxF 'DOCKER-USER -i rakazo-c+ -d 169.254.0.0/16 -j DROP' "$v4_state" | head -1 | cut -d: -f1)"
meta_acc_at="$(grep -nxF 'DOCKER-USER -i rakazo-c+ -d 169.254.0.0/16 -j ACCEPT' "$v4_state" | head -1 | cut -d: -f1)"
[[ -n "$meta_drop_at" && -n "$meta_acc_at" && "$meta_drop_at" -lt "$meta_acc_at" ]] ||
  fail "metadata drop is not above the foreign accept"

# A narrower copy (protocol and port) and a port-specific accept share some
# fields with managed rules. Repair must not delete them.
{
  printf '%s\n' 'DOCKER-USER -j ACCEPT'
  cat "$scratch/v4.clean"
  printf '%s\n' \
    'DOCKER-USER -i rakazo-c+ -d 10.0.0.0/8 -p tcp --dport 22 -j DROP' \
    'INPUT -i rakazo-c+ -p tcp -j ACCEPT'
} >"$v4_state"
RAKAZO_IPTABLES="$bin/iptables" RAKAZO_IP6TABLES="$bin/ip6tables" bash "$script" --apply
grep -qxF 'DOCKER-USER -i rakazo-c+ -d 10.0.0.0/8 -p tcp --dport 22 -j DROP' "$v4_state" ||
  fail "narrower drop was deleted"
grep -qxF 'INPUT -i rakazo-c+ -p tcp -j ACCEPT' "$v4_state" ||
  fail "port-specific accept was deleted"
[[ "$(grep -cxF 'DOCKER-USER -i rakazo-c+ -d 10.0.0.0/8 -j DROP' "$v4_state")" == 1 ]] ||
  fail "managed 10/8 drop missing or duplicated"
[[ "$(grep -cxF 'INPUT -i rakazo-c+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT' "$v4_state")" == 1 ]] ||
  fail "established accept missing or duplicated after keeping foreign rules"

cp "$scratch/v4.clean" "$v4_state"

# --print output replays verbatim: feeding the printed commands through the
# stubbed firewall must reproduce the exact chains --apply built.
replay_dir="$scratch/replay"
mkdir -p "$replay_dir"
for tool in iptables ip6tables; do
  cat >"$replay_dir/$tool" <<'STUB'
#!/usr/bin/env bash
name="$(basename "$0")"
state="$REPLAY_DIR/$name.state"
if [[ "$1" == "-I" ]]; then
  chain="$2"; shift 3 || true
  { printf '%s %s\n' "$chain" "$*"; cat "$state" 2>/dev/null; } >"$state.tmp"
  mv "$state.tmp" "$state"
fi
STUB
  chmod +x "$replay_dir/$tool"
done
REPLAY_DIR="$replay_dir" PATH="$replay_dir:$PATH" bash -c \
  'while IFS= read -r l; do $l; done' <<<"$printed"
diff "$v4_state" "$replay_dir/iptables.state" >/dev/null ||
  fail "--print replay does not reproduce the applied IPv4 chain"
diff "$v6_state" "$replay_dir/ip6tables.state" >/dev/null ||
  fail "--print replay does not reproduce the applied IPv6 chain"

# An ACCEPT inserted above the drops must not survive --apply. The managed
# rules return to the head of DOCKER-USER and the foreign accept falls below.
{ printf '%s\n' 'DOCKER-USER -j ACCEPT'; cat "$v4_state"; } >"$v4_state.tmp"
mv "$v4_state.tmp" "$v4_state"
RAKAZO_IPTABLES="$bin/iptables" RAKAZO_IP6TABLES="$bin/ip6tables" bash "$script" --apply
first="$(head -1 "$v4_state")"
[[ "$first" == 'DOCKER-USER -i rakazo-c+ -o rakazo-c+ -j RETURN' ]] ||
  fail "same-bridge RETURN was not restored to the head, got: $first"
accept_at="$(grep -nxF 'DOCKER-USER -j ACCEPT' "$v4_state" | head -1 | cut -d: -f1)"
meta_at="$(grep -nxF 'DOCKER-USER -i rakazo-c+ -d 169.254.0.0/16 -j DROP' "$v4_state" | head -1 | cut -d: -f1)"
[[ -n "$accept_at" && -n "$meta_at" && "$meta_at" -lt "$accept_at" ]] ||
  fail "metadata drop is not above the foreign ACCEPT"
[[ "$(grep -cxF 'DOCKER-USER -i rakazo-c+ -d 169.254.0.0/16 -j DROP' "$v4_state")" == 1 ]] ||
  fail "repair left a stale metadata drop"
[[ "$(wc -l <"$v4_state")" -eq 15 ]] ||
  fail "repair left duplicate rules, got $(wc -l <"$v4_state") lines"

# A failure halfway through the repair must not remove the drops. 14 inserts
# land the new prefix first; the 15th mutation is the first stale delete and
# is failed before it changes anything. Both the new and previous copies stay.
{ printf '%s\n' 'DOCKER-USER -j ACCEPT' 'INPUT -j ACCEPT'; cat "$v4_state"; } >"$v4_state.tmp"
mv "$v4_state.tmp" "$v4_state"
rm -f "$STUB_DIR/mutation.count"
calls_before="$(wc -l <"$v4_calls")"
STUB_FAIL_ON_MUTATION=15 RAKAZO_IPTABLES="$bin/iptables" RAKAZO_IP6TABLES="$bin/ip6tables" \
  bash "$script" --apply && fail "repair should fail when iptables fails midway" || true
meta_drop='DOCKER-USER -i rakazo-c+ -d 169.254.0.0/16 -j DROP'
input_drop='INPUT -i rakazo-c+ -j DROP'
[[ "$(grep -cxF "$meta_drop" "$v4_state")" == 2 ]] ||
  fail "metadata drop missing after a midway repair failure"
[[ "$(grep -cxF "$input_drop" "$v4_state")" == 2 ]] ||
  fail "INPUT drop missing after a midway repair failure"
new_calls="$(tail -n +"$((calls_before + 1))" "$v4_calls")"
[[ "$(grep -c '^-I ' <<<"$new_calls")" == 14 ]] ||
  fail "repair did not insert the new prefix before failing"
[[ "$(grep -c '^-D ' <<<"$new_calls")" == 1 ]] ||
  fail "repair deleted rules before the new prefix was in place"

# Without ip6tables on PATH the IPv6 family is skipped only when the host has
# no global IPv6 (loopback scope 10). On a dual-stack host (scope 00) the same
# missing chain must fail loudly instead of announcing success.
inet6_local="$scratch/if_inet6.local"
inet6_global="$scratch/if_inet6.global"
printf '%s\n' "00000000000000000000000000000001 01 80 10 80 lo" >"$inet6_local"
printf '%s\n' "20010db800000000000000000000000001 02 40 00 00 eth0" >"$inet6_global"
rm -f "$v4_state" "$v6_state" "$v4_calls" "$STUB_DIR/ip6tables.calls"
RAKAZO_IF_INET6="$inet6_local" RAKAZO_IPTABLES="$bin/iptables" \
  RAKAZO_IP6TABLES="$bin/missing-ip6tables" bash "$script" --apply
[[ ! -e "$v6_state" ]] || fail "IPv6 rules applied despite missing ip6tables"
[[ -f "$v4_state" ]] || fail "IPv4 rules missing when ip6tables absent"
RAKAZO_IF_INET6="$inet6_global" RAKAZO_IPTABLES="$bin/iptables" \
  RAKAZO_IP6TABLES="$bin/missing-ip6tables" bash "$script" --apply &&
  fail "--apply succeeded on dual-stack host without programmable IPv6" || true

# Missing IPv4 iptables must fail loudly — a silent no-op would claim
# restricted egress while installing nothing.
RAKAZO_IPTABLES="$bin/missing-iptables" RAKAZO_IP6TABLES="$bin/missing-ip6tables" \
  bash "$script" --apply && fail "--apply succeeded with no iptables binary" || true

# Docs and Compose keep the flag and script wired together.
docs="$root/../../docs/self-host-docker-computers.md"
grep -q 'restrict-computer-egress.sh' "$docs" || fail "self-host-docker-computers.md does not mention the script"
grep -q 'SANDBOX_COMPUTER_EGRESS' "$docs" || fail "self-host-docker-computers.md does not document the flag"
grep -q 'https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose/restrict-computer-egress.sh' "$docs" ||
  fail "self-host-docker-computers.md does not point VM hosts at the egress script"
grep -q 'name: rakazo-computer-egress' "$docs" ||
  fail "self-host-docker-computers.md does not keep the VM egress helper in its own Compose project"
for compose in docker-compose.yml docker-compose.images.yml docker-compose.topology.yml \
  docker-compose.prod.docker.yml; do
  for flag in SANDBOX_COMPUTER_EGRESS SANDBOX_COMPUTER_DNS; do
    grep -q "$flag" "$root/$compose" || fail "$compose does not pass $flag"
  done
done
# Self-host stacks default to auto: restricted once the rules exist, so an install from before
# them keeps working. An explicit restricted still refuses computers until the rules exist.
for compose in docker-compose.yml docker-compose.images.yml docker-compose.prod.docker.yml; do
  grep -qF 'SANDBOX_COMPUTER_EGRESS: ${SANDBOX_COMPUTER_EGRESS:-auto}' "$root/$compose" ||
    fail "$compose does not default to auto egress"
done
grep -q 'SANDBOX_COMPUTER_EGRESS' "$root/../../.env.example" || fail ".env.example lacks the flag"
grep -q 'SANDBOX_COMPUTER_EGRESS' "$root/.env.images.example" ||
  fail ".env.images.example lacks the flag"

echo "restrict-computer-egress smoke checks passed."
