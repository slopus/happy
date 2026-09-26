#!/bin/sh
# Spike launcher: Xvfb + Chromium with extra flags from $SPIKE_FLAGS, CDP via socat.
export DISPLAY=:99
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp &
sleep 1
socat TCP-LISTEN:9223,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:9222 &
mkdir -p /tmp/profile
exec chromium --user-data-dir=/tmp/profile --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --site-per-process --no-first-run --no-default-browser-check --disable-dev-shm-usage --disable-crash-reporter --disable-breakpad --no-sandbox --display=:99 $SPIKE_FLAGS about:blank
