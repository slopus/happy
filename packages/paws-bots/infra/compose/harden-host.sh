#!/usr/bin/env bash

set -Eeuo pipefail

DEPLOY_USER="${DEPLOY_USER:-deploy}"
SSH_PORT="${SSH_PORT:-22}"
[[ "${SSH_PORT}" =~ ^[0-9]+$ ]] && ((SSH_PORT > 0 && SSH_PORT <= 65535)) || { echo "Invalid SSH_PORT" >&2; exit 1; }

if [[ "${EUID}" -ne 0 ]]; then
  exec sudo --preserve-env=DEPLOY_USER,SSH_PORT,SSH_CONNECTION,RAKAZO_DEPLOY_DIR bash "$0" "$@"
fi

# Validate the guard's session identity before installing packages or writing host settings.
[[ -n "${SSH_CONNECTION:-}" ]] || { echo "SSH_CONNECTION is required; use sudo --preserve-env=SSH_CONNECTION" >&2; exit 1; }

if ! id "${DEPLOY_USER}" >/dev/null 2>&1; then
  echo "Deploy user ${DEPLOY_USER} does not exist" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  age \
  apparmor \
  apparmor-utils \
  auditd \
  audispd-plugins \
  fail2ban \
  needrestart \
  nftables \
  ufw \
  unattended-upgrades

install -d -m 755 /etc/ssh/sshd_config.d
cat >/etc/ssh/sshd_config.d/99-rakazo-hardening.conf <<EOF
PermitRootLogin no
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
AuthenticationMethods publickey
PermitEmptyPasswords no
HostbasedAuthentication no
GSSAPIAuthentication no
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding local
GatewayPorts no
PermitTunnel no
LoginGraceTime 30
MaxAuthTries 3
MaxSessions 4
MaxStartups 10:30:30
ClientAliveInterval 300
ClientAliveCountMax 2
UseDNS no
LogLevel VERBOSE
AllowUsers ${DEPLOY_USER}
EOF
chmod 600 /etc/ssh/sshd_config.d/99-rakazo-hardening.conf
sshd -t

cat >/etc/fail2ban/jail.d/sshd.local <<EOF
[sshd]
enabled = true
backend = systemd
port = ${SSH_PORT}
maxretry = 3
findtime = 10m
bantime = 1h
bantime.increment = true
bantime.factor = 2
bantime.maxtime = 1w
banaction = ufw
EOF

cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

cat >/etc/apt/apt.conf.d/52rakazo-unattended-upgrades <<'EOF'
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Remove-New-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
EOF

cat >/etc/sysctl.d/99-rakazo-hardening.conf <<'EOF'
fs.protected_fifos = 2
fs.protected_hardlinks = 1
fs.protected_regular = 2
fs.protected_symlinks = 1
kernel.dmesg_restrict = 1
kernel.kptr_restrict = 2
kernel.perf_event_paranoid = 3
kernel.unprivileged_bpf_disabled = 1
kernel.yama.ptrace_scope = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.all.log_martians = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv4.conf.default.log_martians = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.default.secure_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
net.ipv4.tcp_rfc1337 = 1
net.ipv4.tcp_syncookies = 1
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv6.conf.default.accept_source_route = 0
EOF
if [[ -e /proc/sys/net/mptcp/enabled ]]; then
  echo 'net.mptcp.enabled = 0' >>/etc/sysctl.d/99-rakazo-hardening.conf
fi
sysctl --system >/dev/null

# Internet TCP never needs IPv4 options, and the kernel's handling of them is a recurring source of remote bugs.
install -m 0644 "$(dirname "$0")/../systemd/rakazo-drop-ip-options.service" /etc/systemd/system/rakazo-drop-ip-options.service
systemctl daemon-reload
systemctl enable rakazo-drop-ip-options.service
systemctl restart rakazo-drop-ip-options.service

if [[ -z "${RAKAZO_DEPLOY_DIR:-}" && -r /etc/rakazo/deploy.env ]]; then
  RAKAZO_DEPLOY_DIR="$(sed -n 's/^RAKAZO_DEPLOY_DIR=//p' /etc/rakazo/deploy.env | tail -1 | tr -d '"')"
fi
DEPLOY_DIR="${RAKAZO_DEPLOY_DIR:-/srv/rakazo}"
[[ "${DEPLOY_DIR}" == /* ]] || { echo "RAKAZO_DEPLOY_DIR must be an absolute path" >&2; exit 1; }
DEPLOY_HOME="$(getent passwd "${DEPLOY_USER}" | cut -d: -f6)"

# The kernel needs a watched path's parent directory to exist; rerun after creating a skipped one.
install -d -m 750 /etc/audit/rules.d
audit_watches=(
  "/etc/ssh/sshd_config sshd_config"
  "/etc/ssh/sshd_config.d/ sshd_config"
  "/etc/sudoers sudoers"
  "/etc/sudoers.d/ sudoers"
  "/etc/passwd identity"
  "/etc/group identity"
  "/etc/shadow identity"
  "/etc/gshadow identity"
  "${DEPLOY_HOME}/.ssh/authorized_keys ssh_keys"
  "/root/.ssh ssh_keys"
  "/etc/rakazo rakazo_config"
  "${DEPLOY_DIR}/.env app_secrets"
  "/usr/local/sbin host_scripts"
  "/etc/systemd/system persistence"
  "/etc/cron.d persistence"
  "/var/spool/cron persistence"
  "/etc/docker/daemon.json docker_config"
)
for watch in "${audit_watches[@]}"; do
  read -r path key <<<"${watch}"
  if [[ -d "$(dirname "${path}")" ]]; then
    printf -- '-w %s -p wa -k %s\n' "${path}" "${key}"
  else
    echo "Skipping audit watch on ${path}: its directory does not exist" >&2
  fi
done >/etc/audit/rules.d/50-rakazo.rules
augenrules --load >/dev/null

# Keep existing private-network rules. Roll back unless a fresh SSH session confirms.
install -m 0755 "$(dirname "$0")/firewall-change.sh" /usr/local/sbin/rakazo-firewall-change
/usr/local/sbin/rakazo-firewall-change apply bash -euc '
  ufw default deny incoming
  ufw default allow outgoing
  ufw limit "$1/tcp" comment "Rate-limited SSH"
  ufw allow 80/tcp comment "HTTP for ACME redirect"
  ufw allow 443/tcp comment "HTTPS"
  ufw allow 443/udp comment "HTTP/3"
  ufw --force enable
' _ "${SSH_PORT}"

systemctl enable --now apparmor auditd fail2ban unattended-upgrades
systemctl restart fail2ban
systemctl reload ssh

# Ship the audit trail off the host only when an operator configured a sink; see docs/self-host-observability.md#host-audit-trail.
AUDIT_ENV=/etc/rakazo/audit-ship.env
if grep -q '^RAKAZO_AUDIT_SINK_URL=.' "${AUDIT_ENV}" 2>/dev/null; then
  audit_token="$(sed -n 's/^RAKAZO_AUDIT_TOKEN_FILE=//p' "${AUDIT_ENV}" | tail -1 | tr -d '"')"
  audit_token="${audit_token:-/etc/rakazo/audit-ship.token}"
  [[ -s "${audit_token}" ]] || { echo "Audit sink is configured but ${audit_token} is missing or empty" >&2; exit 1; }
  chown root:root "${AUDIT_ENV}" "${audit_token}"
  chmod 600 "${AUDIT_ENV}" "${audit_token}"
  install -m 0755 "$(dirname "$0")/audit-ship.py" /usr/local/sbin/rakazo-audit-ship
  install -m 0644 "$(dirname "$0")/../systemd/rakazo-audit-ship.service" /etc/systemd/system/rakazo-audit-ship.service
  systemctl daemon-reload
  systemctl enable rakazo-audit-ship.service
  systemctl restart rakazo-audit-ship.service
fi

echo "Host hardening applied. Confirm the firewall token from a fresh SSH session within three minutes."
