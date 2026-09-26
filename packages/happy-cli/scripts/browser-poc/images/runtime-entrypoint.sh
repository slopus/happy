#!/bin/sh
# Browser Runtime container entrypoint (D9 writer lock).
# Takes an exclusive kernel flock on runtime.flock in the state volume — a file
# that is never replaced — before node opens the TaskStore or any CDP
# connection. -n: a second Runtime on the same state volume exits at once
# (status 75, the restart policy backs off). -F: no fork, so node itself holds
# the lock for its whole life and the kernel drops it when node dies.
#
# Production starts the container as root with only CAP_SETUID/CAP_SETGID
# (see src/browserRuntime/privilegeDrop.ts): node reads the root-only config,
# binds the /run/abp sockets and then drops to ABP_RUNTIME_UID/GID. The state
# volume belongs to that user, so the state dir and lock file are created as
# it, and root opens the lock read-only as a member of its group (no DAC
# override needed even when the state dir is 0750).
set -eu
state_dir="${ABP_STATE_DIR:-/var/lib/abp/state}"
ABP_WRITER_FLOCK="$state_dir/runtime.flock"
export ABP_WRITER_FLOCK
if [ "$(id -u)" = 0 ]; then
    : "${ABP_RUNTIME_UID:?}" "${ABP_RUNTIME_GID:?}"
    setpriv --reuid="$ABP_RUNTIME_UID" --regid="$ABP_RUNTIME_GID" --clear-groups \
        sh -c 'mkdir -p "$1" && : >> "$2"' abp-prepare "$state_dir" "$ABP_WRITER_FLOCK"
    exec setpriv --groups="$ABP_RUNTIME_GID" flock -n -E 75 -F "$ABP_WRITER_FLOCK" node /app/runtime.mjs
fi
mkdir -p "$state_dir"
exec flock -n -E 75 -F "$ABP_WRITER_FLOCK" node /app/runtime.mjs
