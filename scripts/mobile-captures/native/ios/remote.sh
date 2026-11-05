#!/usr/bin/env bash
# Run the iOS capture on a Mac from any machine with ssh and rsync.
#
#   MAC=user@host ios/remote.sh sync                     copy this checkout to the Mac (no .git)
#   MAC=user@host ios/remote.sh install [install.py args] install the story fixture into the copy
#   MAC=user@host ios/remote.sh capture TARGET --sim UDID --out NAME [capture.py args]
#   MAC=user@host ios/remote.sh fetch NAME LOCAL_DIR      copy results/NAME back
#   MAC=user@host ios/remote.sh status                    simulators booted, capture processes, disk
#
# Environment:
#   MAC          ssh destination (required)
#   REMOTE_ROOT  folder on the Mac (default: happy-captures, relative to the remote home)
#   COPY_NAME    name of the repository copy under REMOTE_ROOT (default: repo)
#   REPO         checkout to sync (default: this script's repository)
#   SSHPASS      if set, ssh and rsync authenticate through `sshpass -e`
#   SSH_OPTS     extra ssh options (for example "-o UserKnownHostsFile=...")
#
# capture --out NAME is created under REMOTE_ROOT/results and must not exist yet. Relative
# paths in capture args (--hinge, --derived-data) are resolved on the Mac.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
: "${MAC:?set MAC=user@host}"
REMOTE_ROOT=${REMOTE_ROOT:-happy-captures}
COPY_NAME=${COPY_NAME:-repo}
REPO=${REPO:-$(cd "$here/../../../.." && pwd)}
copy="$REMOTE_ROOT/$COPY_NAME"
native="$copy/scripts/mobile-captures/native"

ssh_cmd=(ssh ${SSH_OPTS:-})
[ -n "${SSHPASS:-}" ] && ssh_cmd=(sshpass -e "${ssh_cmd[@]}")
remote() { "${ssh_cmd[@]}" "$MAC" "export PATH=/opt/homebrew/bin:\$PATH; $*"; }
quote() { [ $# -eq 0 ] || printf '%q ' "$@"; }

case "${1:-}" in
  sync)
    commit=$(git -C "$REPO" rev-parse HEAD)
    dirty=$(git -C "$REPO" status --porcelain | head -c1)
    remote "mkdir -p $(quote "$copy") $(quote "$REMOTE_ROOT/results")"
    # The copy belongs to this tool: --delete keeps it equal to the checkout; build output is kept.
    rsync -a --delete -e "$(quote "${ssh_cmd[@]}")" \
      --exclude .git --exclude node_modules --exclude .context --exclude build --exclude .gradle \
      --exclude DerivedData --exclude '*.xcresult' --filter 'P .capture-derived/' --filter 'P SOURCE_COMMIT' \
      "$REPO/" "$MAC:$copy/"
    remote "printf '%s%s\n' $(quote "$commit") $(quote "${dirty:+ (with uncommitted changes)}") > $(quote "$copy/SOURCE_COMMIT")"
    echo "synced $commit${dirty:+ + local changes} to $MAC:$copy"
    ;;
  install)
    shift
    remote "python3 $(quote "$native/ios/install.py") --repo $(quote "$copy") $(quote "$@")"
    ;;
  capture)
    shift
    target=$1; shift
    args=()
    while [ $# -gt 0 ]; do
      if [ "$1" = --out ]; then args+=(--out "$REMOTE_ROOT/results/$2"); shift 2; else args+=("$1"); shift; fi
    done
    remote "cd \$HOME && mkdir -p $(quote "$REMOTE_ROOT/results") && python3 -u $(quote "$native/ios/capture.py") $(quote "$target") --repo $(quote "$copy") $(quote "${args[@]}")"
    ;;
  fetch)
    name=$2 dest=$3
    mkdir -p "$dest"
    rsync -a -e "$(quote "${ssh_cmd[@]}")" --exclude '*.xcresult' "$MAC:$REMOTE_ROOT/results/$name/" "$dest/"
    check=(sha256sum -c --quiet); command -v sha256sum >/dev/null || check=(shasum -a 256 -c --quiet)
    if (cd "$dest" && "${check[@]}" SHA256SUMS); then echo "fetched $name, hashes match"; else echo "hash mismatch in $dest" >&2; exit 1; fi
    ;;
  status)
    remote "xcrun simctl list devices booted; pgrep -fl 'capture.py|xcodebuild|recordVideo' || true; df -h / | tail -1"
    ;;
  *)
    sed -n '2,20p' "$0"; exit 2 ;;
esac
