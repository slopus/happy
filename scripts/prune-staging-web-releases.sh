#!/usr/bin/env bash
# Keep the active staging release and its single rollback target.
set -euo pipefail

readonly root="${1:?Usage: prune-staging-web-releases.sh <root> <current-revision> <previous-revision>}"
readonly current_revision="${2:?Usage: prune-staging-web-releases.sh <root> <current-revision> <previous-revision>}"
readonly previous_revision="${3:?Usage: prune-staging-web-releases.sh <root> <current-revision> <previous-revision>}"
readonly releases="$root/releases"

[[ "$current_revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid current revision.' >&2; exit 2; }
[[ "$previous_revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid previous revision.' >&2; exit 2; }
[[ -d "$releases" ]] || { echo "Missing releases directory: $releases" >&2; exit 1; }

exec 9> "$root/.deploy.lock"
flock -x 9

[[ "$(cat "$root/current/.paws-release-revision")" == "$current_revision" ]] || {
    echo 'Current release changed concurrently; refusing to prune.' >&2
    exit 1
}
[[ "$(cat "$root/previous/.paws-release-revision")" == "$previous_revision" ]] || {
    echo 'Rollback release changed concurrently; refusing to prune.' >&2
    exit 1
}

for release in "$releases"/*; do
    [[ -d "$release" ]] || continue
    revision="${release##*/}"
    [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || continue
    [[ "$revision" == "$current_revision" || "$revision" == "$previous_revision" ]] && continue
    rm -rf -- "$release"
done
