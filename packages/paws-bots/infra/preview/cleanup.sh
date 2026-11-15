#!/usr/bin/env bash
# Deletes previews: the one for PR when it is set (the pull request closed), otherwise every
# preview whose pull request is no longer open, to catch a missed close.
#
# Env: FLY_API_TOKEN, FLY_ORG, GH_TOKEN, REPO, optional PR, APP_PREFIX (default rakazo-pr).
set -euo pipefail

prefix="${APP_PREFIX:-rakazo-pr}"

destroy() {
  local number=$1 app="$prefix-$1"
  flyctl status --app "$app" > /dev/null 2>&1 || return 0
  flyctl apps destroy "$app" --yes
  local marker="<!-- rakazo-preview -->" existing
  existing=$(gh api "repos/$REPO/issues/$number/comments" --paginate \
    --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | startswith(\"$marker\"))) | .id" |
    head -n 1)
  [[ -z $existing ]] || gh api -X PATCH "repos/$REPO/issues/comments/$existing" \
    -f body="$marker
Preview removed." > /dev/null
}

if [[ -n ${PR:-} ]]; then
  [[ $PR =~ ^[0-9]+$ ]] || { echo "Bad pull request number" >&2; exit 1; }
  destroy "$PR"
  exit 0
fi

flyctl apps list --org "$FLY_ORG" --json | jq -r '.[] | (.Name // .name)' |
  while read -r app; do
    [[ $app =~ ^$prefix-([0-9]+)$ ]] || continue
    number=${BASH_REMATCH[1]}
    # Only a confirmed close deletes; a failed lookup keeps the preview for the next sweep.
    if [[ $(gh api "repos/$REPO/pulls/$number" --jq .state 2> /dev/null) == closed ]]; then
      destroy "$number"
    fi
  done
