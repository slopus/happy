#!/bin/bash
set -xe

BRANCH=$(git branch --show-current)
git stash && git checkout main && git stash pop
git commit -am "commit to main: $*"

(git pull origin main && git push origin main) || echo "Could not PUSH main changes."

git checkout "$BRANCH"
git merge main --no-edit
# git pull origin main
