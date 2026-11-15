#!/usr/bin/env bash
# Deploys a loaded preview image for one pull request and posts or updates its link.
# Runs from the base branch with deploy credentials, so it never runs the pull request's code:
# the image only moves from the local Docker daemon to the host's registry.
#
# Env: PR, HEAD_SHA, IMAGE (local tag), FLY_API_TOKEN, FLY_ORG, REGION, GH_TOKEN, REPO,
# APP_PREFIX (default rakazo-pr).
set -euo pipefail

[[ $PR =~ ^[0-9]+$ ]] || { echo "Bad pull request number" >&2; exit 1; }
[[ $HEAD_SHA =~ ^[0-9a-f]{40}$ ]] || { echo "Bad commit" >&2; exit 1; }
app="${APP_PREFIX:-rakazo-pr}-$PR"
here=$(cd "$(dirname "$0")" && pwd)

flyctl status --app "$app" > /dev/null 2>&1 || flyctl apps create "$app" --org "$FLY_ORG"
if [[ $(flyctl volumes list --app "$app" --json | jq length) == 0 ]]; then
  flyctl volumes create preview_data --app "$app" --region "$REGION" --size 1 --yes
fi

flyctl auth docker
remote="registry.fly.io/$app:$HEAD_SHA"
docker tag "$IMAGE" "$remote"
docker push --quiet "$remote"
flyctl deploy --app "$app" --config "$here/fly.toml" --image "$remote" \
  --primary-region "$REGION" --ha=false

marker="<!-- rakazo-preview -->"
commit_marker=$(python3 "$here/../../.github/scripts/pr-screenshots.py" marker "$HEAD_SHA")
body="$marker
$commit_marker
**Preview:** https://$app.fly.dev · \`preview@example.com\` / \`rakazo-preview-demo\` · ${HEAD_SHA:0:7}"
existing=$(gh api "repos/$REPO/issues/$PR/comments" --paginate \
  --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | startswith(\"$marker\"))) | .id" |
  head -n 1)
if [[ -n $existing ]]; then
  gh api -X PATCH "repos/$REPO/issues/comments/$existing" -f body="$body" > /dev/null
else
  gh api "repos/$REPO/issues/$PR/comments" -f body="$body" > /dev/null
fi

# A close that arrived while this deployed found nothing to delete yet.
if [[ $(gh api "repos/$REPO/pulls/$PR" --jq .state) == closed ]]; then
  bash "$here/cleanup.sh"
fi
