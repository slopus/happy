#!/bin/sh
set -eu
export DISPLAY=:99
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp &
# Human input reaches this display only through the Runtime's viewer proxy (D2),
# which enforces the takeover lease. x11vnc therefore listens on the profile
# network (never published) and still requires the per-run password, which only
# the Runtime holds.
test -n "${ABP_VNC_PASSWORD:-}"
x11vnc -storepasswd "$ABP_VNC_PASSWORD" /tmp/vncpass >/dev/null 2>&1
unset ABP_VNC_PASSWORD
x11vnc -display :99 -rfbport 5900 -forever -shared -rfbauth /tmp/vncpass >/tmp/x11vnc.log 2>&1 &
# PoC harness only (ABP_HARNESS_NOVNC=1): direct noVNC on 6080 for the A11 raw-surface checks.
if [ "${ABP_HARNESS_NOVNC:-0}" = "1" ]; then
  websockify --web /usr/share/novnc/ 0.0.0.0:6080 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &
fi
socat TCP-LISTEN:9223,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:9225 &
python3 /usr/local/bin/cdp-proxy &
python3 /usr/local/bin/instance-server &
# The fixture's address is resolved on every Chromium launch, not pinned when the
# container is created: container IPs are reassigned when the machine reboots.
host_rules() {
  ip=""
  if [ -n "${ABP_FIXTURE_ALIAS:-}" ]; then
    for _ in $(seq 60); do
      ip=$(getent hosts "$ABP_FIXTURE_ALIAS" | awk '{print $1; exit}')
      [ -n "$ip" ] && break
      sleep 1
    done
  fi
  ip=${ip:-127.0.0.1}
  echo "MAP a.poc-one.test $ip,MAP b.poc-two.test $ip,MAP c.poc-three.test $ip"
}
while :; do
  rm -f /home/browser/profile/Singleton*
  # Drop the previous identity before the new Chromium can accept CDP
  # connections, so a reconnecting Runtime can never pair the new browser
  # with the old browserInstanceId.
  rm -f /run/abp/instance.json
  browser_id=$(cat /proc/sys/kernel/random/uuid)
  # Every agent tab is its own window; these per-window omnibox WebUI renderers
  # cost ~17 MiB PSS per window and are never used (no one types in the omnibox).
  chromium --disable-features=WebUIOmniboxPopup,WebUIOmniboxAimPopup,WebUIOmniboxFullPopup --user-data-dir=/home/browser/profile --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --site-per-process --no-first-run --no-default-browser-check --disable-dev-shm-usage --disable-crash-reporter --disable-breakpad --no-sandbox --display=:99 --host-resolver-rules="$(host_rules)" about:blank >/tmp/chromium.log 2>&1 &
  chrome_pid=$!
  printf '{"browserInstanceId":"%s","chromePid":%s,"startedAtMs":%s}\n' "$browser_id" "$chrome_pid" "$(($(date +%s)*1000))" > /run/abp/instance.json.tmp
  mv /run/abp/instance.json.tmp /run/abp/instance.json
  wait "$chrome_pid" || true
  sleep 1
done
