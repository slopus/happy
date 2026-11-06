#!/bin/bash
# Builds the sync proofs and fails on any sorry, admit, axiom of our own,
# or theorem resting on an axiom beyond propext, Classical.choice, Quot.sound.
set -euo pipefail
cd "$(dirname "$0")"
if grep -rnE '\b(sorry|admit)\b|^\s*axiom\s' SyncProofs SyncProofs.lean; then
  echo "unfinished proof or new axiom"; exit 1
fi
lake build
out=$(lake env lean Axioms.lean)
echo "$out"
if echo "$out" | grep -q sorryAx; then exit 1; fi
bad=$(echo "$out" | grep -oE "depends on axioms: \[[^]]*\]" | tr -d '[]' | sed 's/depends on axioms: //' | tr ',' '\n' | tr -d ' ' | grep -vE '^(propext|Classical\.choice|Quot\.sound)$' || true)
[ -z "$bad" ] || { echo "unexpected axioms: $bad"; exit 1; }
echo "proofs ok"
