#!/bin/bash
set -xe

BRANCH=$(git branch --show-current)
git stash && git checkout main && git stash pop
git commit -am "commit to main: $*"
git push origin main
git checkout "$BRANCH"
git merge main --no-edit
# git pull origin main
