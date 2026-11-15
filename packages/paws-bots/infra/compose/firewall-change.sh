#!/usr/bin/env bash
# Wrap firewall edits with a timed rollback; confirm from a fresh SSH connection.
set -euo pipefail
[[ "${EUID}" == 0 ]] || { echo "Run as root, preserving SSH_CONNECTION" >&2; exit 1; }
STATE=/var/lib/rakazo/firewall-change
install -d -m 700 "${STATE}"
exec 9>"${STATE}/lock"
action="${1:-}"; shift || true
if [[ "${action}" == rollback ]]; then
  flock 9
else
  flock -n 9 || { echo "Another firewall operation is running" >&2; exit 1; }
fi
case "${action}" in
  apply)
    [[ -n "${SSH_CONNECTION:-}" ]] || { echo "SSH_CONNECTION is required; preserve it through sudo" >&2; exit 1; }
    (($# > 0)) || { echo "Usage: firewall-change apply COMMAND [ARGS...]" >&2; exit 1; }
    [[ ! -f "${STATE}/token" ]] || { echo "A firewall change is awaiting confirmation" >&2; exit 1; }
    # Refuse edits when the configuration filesystem is nearly full.
    free_kb="$(df -Pk /etc/ufw | awk 'NR == 2 { print $4 }')"
    ((free_kb >= 102400)) || { echo "Need at least 100MiB free before changing the firewall" >&2; exit 1; }
    token="$(cat /proc/sys/kernel/random/uuid)"
    tar -cpf "${STATE}/before.tar" -C /etc ufw default/ufw
    status="$(LC_ALL=C ufw status)"
    if grep -q '^Status: active$' <<<"${status}"; then
      echo 1 >"${STATE}/enabled"
    elif grep -q '^Status: inactive$' <<<"${status}"; then
      echo 0 >"${STATE}/enabled"
    else
      echo "Could not determine the current firewall state" >&2
      exit 1
    fi
    printf '%s\n' "${SSH_CONNECTION:-}" >"${STATE}/connection"
    printf '%s\n' "${token}" >"${STATE}/token"
    if ! systemd-run --quiet --collect --unit=rakazo-firewall-rollback --on-active=180s \
      --timer-property=AccuracySec=1s --timer-property=RemainAfterElapse=no "$(readlink -f "$0")" rollback "${token}"; then
      rm -f "${STATE}/token"
      echo "Could not schedule rollback; firewall was not changed" >&2
      exit 1
    fi
    echo "Rollback armed. After verifying a NEW SSH connection, run:"
    echo "sudo --preserve-env=SSH_CONNECTION /usr/local/sbin/rakazo-firewall-change confirm ${token}"
    # Children must not retain the operation lock (including long-lived services).
    timeout --kill-after=5s 120s "$@" 9>&-
    ;;
  confirm|rollback)
    [[ -f "${STATE}/token" && "${1:-}" == "$(cat "${STATE}/token")" ]] || {
      echo "No pending firewall change with that token" >&2; exit 1;
    }
    if [[ "${action}" == confirm ]]; then
      [[ -n "${SSH_CONNECTION:-}" && "${SSH_CONNECTION}" != "$(cat "${STATE}/connection")" ]] || {
        echo "Confirm from a fresh SSH connection, preserving SSH_CONNECTION through sudo" >&2; exit 1;
      }
      systemctl stop rakazo-firewall-rollback.timer
    else
      tar -xpf "${STATE}/before.tar" -C /etc
      if [[ "$(cat "${STATE}/enabled")" == 1 ]]; then
        ufw --force enable
      else
        ufw --force disable
      fi
      if ! systemctl stop rakazo-firewall-rollback.timer; then
        timer_state="$(systemctl show rakazo-firewall-rollback.timer --property=ActiveState --value)" || exit 1
        [[ "${timer_state}" == inactive ]] || { echo "Rollback timer cleanup failed; pending state retained" >&2; exit 1; }
      fi
      logger -p authpriv.warning -t rakazo-firewall-change "Restored firewall after an unconfirmed change"
    fi
    rm -f "${STATE}/token"
    echo "Firewall change ${action} completed"
    ;;
  *) echo "Usage: firewall-change {apply COMMAND...|confirm TOKEN|rollback TOKEN}" >&2; exit 1 ;;
esac
