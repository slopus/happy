#!/bin/bash
set -e

echo "Creating monorepo with proper structure..."

# Initialize the monorepo
git init
git commit --allow-empty -m "Initial commit"

# Clone each repo into temp directories and process with git-filter-repo
echo "Processing handy -> app..."
git clone ../handy temp-app
cd temp-app
git checkout monorepo
git filter-repo --to-subdirectory-filter app --force
git filter-repo --message-callback 'return b"[app] " + message if not message.startswith(b"[app]") else message' --force
cd ..

echo "Processing handy-cli -> cli..."
git clone ../handy-cli temp-cli
cd temp-cli
git checkout monorepo
git filter-repo --to-subdirectory-filter cli --force
git filter-repo --message-callback 'return b"[cli] " + message if not message.startswith(b"[cli]") else message' --force
cd ..

echo "Processing handy-server -> server..."
git clone ../handy-server temp-server
cd temp-server
git checkout monorepo
git filter-repo --to-subdirectory-filter server --force
git filter-repo --message-callback 'return b"[server] " + message if not message.startswith(b"[server]") else message' --force
cd ..

echo "Processing dev-environment..."
git clone ../dev-environment temp-dev
cd temp-dev
git checkout main
git filter-repo --to-subdirectory-filter dev-environment --force
git filter-repo --message-callback 'return b"[dev-environment] " + message if not message.startswith(b"[dev-environment]") else message' --force
cd ..

# Add remotes and merge
echo "Merging repositories..."
git remote add app ./temp-app
git fetch app
git merge app/monorepo --allow-unrelated-histories -m "Merge app (handy) repository"

git remote add cli ./temp-cli
git fetch cli
git merge cli/monorepo --allow-unrelated-histories -m "Merge cli (handy-cli) repository"

git remote add server ./temp-server
git fetch server
git merge server/monorepo --allow-unrelated-histories -m "Merge server (handy-server) repository"

git remote add dev ./temp-dev
git fetch dev
git merge dev/main --allow-unrelated-histories -m "Merge dev-environment repository"

# Cleanup
echo "Cleaning up..."
rm -rf temp-app temp-cli temp-server temp-dev
git remote remove app
git remote remove cli
git remote remove server
git remote remove dev

echo "Done! The monorepo has been created with all histories preserved."