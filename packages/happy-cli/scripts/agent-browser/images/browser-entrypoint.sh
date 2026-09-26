#!/bin/sh
# Production browser container (abp-stack). Chromium runs with its own sandbox
# (no --no-sandbox; the seccomp profile allows its namespace calls). x11vnc
# listens on this profile's network only (nothing is published) and requires the
# per-machine password, which only the Runtime's viewer proxy also holds (D2).
set -eu
export DISPLAY=:99
password_file=/run/secrets/abp/vnc-password
test -r "$password_file"
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp &
# -passwdfile keeps the password off the command line. abp-stack rotate-keys
# replaces the file and stops x11vnc; this loop starts it with the new one.
(
  while :; do
    x11vnc -display :99 -rfbport 5900 -forever -shared -passwdfile "$password_file" -o /tmp/x11vnc.log >/dev/null 2>&1 || true
    sleep 1
  done
) &
socat TCP-LISTEN:9223,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:9225 &
python3 /usr/local/bin/cdp-proxy &
python3 /usr/local/bin/instance-server &
while :; do
  rm -f /home/browser/profile/Singleton*
  # Drop the previous identity before the new Chromium accepts CDP connections,
  # so a reconnecting Runtime never pairs the new browser with the old id.
  rm -f /run/abp/instance.json
  browser_id=$(cat /proc/sys/kernel/random/uuid)
  chromium --user-data-dir=/home/browser/profile --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --site-per-process --no-first-run --no-default-browser-check --disable-dev-shm-usage --disable-crash-reporter --disable-breakpad --display=:99 about:blank >/tmp/chromium.log 2>&1 &
  chrome_pid=$!
  printf '{"browserInstanceId":"%s","chromePid":%s,"startedAtMs":%s}\n' "$browser_id" "$chrome_pid" "$(($(date +%s)*1000))" > /run/abp/instance.json.tmp
  mv /run/abp/instance.json.tmp /run/abp/instance.json
  wait "$chrome_pid" || true
  sleep 1
done
