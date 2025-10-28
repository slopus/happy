#!/bin/bash
set -xe

BRANCH=$(git branch --show-current)
git stash && git checkout main && git stash pop
git commit -am "$*"
git push origin main
git checkout "$BRANCH"
git pull origin main
