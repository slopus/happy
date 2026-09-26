#!/bin/bash
set -euo pipefail
[[ -f /.dockerenv && ${HAPPY_SANDBOX_LINUX_SMOKE:-} == 1 && $(id -u) == 0 ]] || exit 125
install -o root -g root -m 0755 scripts/agent-browser/claude-sbx-launch /usr/local/libexec/abp/claude-sbx-launch
gcc -Wall -Wextra -Werror scripts/agent-browser/abp-firewall-read.c -o /usr/local/libexec/abp/abp-firewall-read
chown root:abp-session /usr/local/libexec/abp/abp-firewall-read
chmod 4750 /usr/local/libexec/abp/abp-firewall-read
# Real host resolver and buses, backed exclusively by synthetic DNS inside this netns.
mkdir -p /run/dbus /run/systemd /run/nscd
cat > /etc/systemd/resolved.conf <<'EOF'
[Resolve]
DNS=127.0.0.1:5353
FallbackDNS=
DNSStubListener=no
LLMNR=no
MulticastDNS=no
DNSSEC=no
EOF
sed -i 's/^hosts:.*/hosts: files resolve [!UNAVAIL=return] dns/' /etc/nsswitch.conf
python3 scripts/sandbox-dns-fixture.py &
dbus-daemon --system --fork
SYSTEMD_LOG_LEVEL=warning /lib/systemd/systemd-resolved &
nscd
for i in {1..100}; do
    if resolvectl query exfil.unapproved.test >/dev/null 2>&1; then break; fi
    sleep .05
done
resolvectl query exfil.unapproved.test >/dev/null
exec node --import /test/node_modules/tsx/dist/loader.mjs scripts/sandbox-linux-smoke.ts
