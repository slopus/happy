#!/usr/bin/env bash
# Copies the chat UI contract into the app's test resources: the catalog's
# schemas (ui.schema.json) and the client package's conformance vectors
# (actions.fixtures.json), as happy-agent has them at one commit, with a
# record of that commit and each file's SHA-256 (vendored.json). The tests in
# app/src/test/.../conversation/ui read them; UiContractTest fails when a
# file and its recorded hash disagree, so they are never edited by hand.
#
# The files are read from the commit itself, so the checkout may be on any
# branch and is left as it is:
#
#   tools/chat-ui/vendor.sh <happy-agent checkout> <commit>
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: $0 <happy-agent checkout> <commit>" >&2; exit 2; }
checkout="$1"
commit="$(git -C "$checkout" rev-parse --verify "$2^{commit}")"
source=packages/happy-agent-client/fixtures/ui
here="$(cd "$(dirname "$0")" && pwd)"
dest="$here/../../app/src/test/resources/ui"
files=(actions.fixtures.json ui.schema.json)
mkdir -p "$dest"
for file in "${files[@]}"; do
  git -C "$checkout" show "$commit:$source/$file" > "$dest/$file"
done
{
  printf '{\n  "source": "happy-agent %s",\n  "commit": "%s",\n  "sha256": {\n' "$source" "$commit"
  for i in "${!files[@]}"; do
    sum="$(shasum -a 256 "$dest/${files[$i]}" | cut -d ' ' -f 1)"
    [ "$i" -eq $((${#files[@]} - 1)) ] && comma='' || comma=','
    printf '    "%s": "%s"%s\n' "${files[$i]}" "$sum" "$comma"
  done
  printf '  }\n}\n'
} > "$dest/vendored.json"
echo "Vendored $source at $commit"
