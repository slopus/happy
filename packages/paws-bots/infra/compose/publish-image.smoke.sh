#!/usr/bin/env bash
# Exercise publication without a registry, credentials, or Docker daemon.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
mkdir -p "$scratch/bin" "$scratch/digests"
cat > "$scratch/bin/docker" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1 $2" == 'buildx imagetools' ]] || exit 1
case "$3" in
  create)
    if [[ "$4" == --dry-run ]]; then
      [[ "${FAIL_DRY_RUN:-0}" != 1 ]] || exit 1
      cat "$MANIFEST"
    else
      [[ "${FAIL_PUSH:-0}" != 1 ]] || exit 1
      printf '%s\n' "$@" >> "$PUSHED"
    fi
    ;;
  inspect)
    [[ "${FAIL_INSPECT:-0}" != 1 ]] || exit 1
    printf 'sha256:%064d\n' 9
    ;;
  *) exit 1 ;;
esac
FAKE
cat > "$scratch/bin/git" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == 'ls-remote --exit-code origin refs/heads/main' ]] || exit 1
[[ "${FAIL_MAIN:-0}" != 1 ]] || exit 1
printf '%s\trefs/heads/main\n' "$MAIN_SHA"
FAKE
chmod +x "$scratch/bin/"*
export PATH="$scratch/bin:$PATH"
export IMAGE=registry.example.test/project/app
export DIGESTS_DIRECTORY="$scratch/digests"
export GITHUB_REF=refs/heads/main
export GITHUB_SHA=1111111111111111111111111111111111111111
export MAIN_SHA="$GITHUB_SHA"
export GITHUB_OUTPUT="$scratch/outputs"
export MANIFEST="$scratch/manifest.json"
export PUSHED="$scratch/pushed"
export TAGS="$IMAGE:sha-$GITHUB_SHA"$'\n'"$IMAGE:edge"
cat > "$MANIFEST" <<'JSON'
{"manifests":[{"platform":{"os":"linux","architecture":"amd64"}},{"platform":{"os":"linux","architecture":"arm64"}}]}
JSON
one="$(printf '%064d' 1)"
two="$(printf '%064d' 2)"
: > "$DIGESTS_DIRECTORY/$one"
publish() {
  rm -f "$PUSHED" "$GITHUB_OUTPUT"
  bash "$root/.github/actions/publish-image/publish.sh" > "$scratch/log" 2>&1
}
publish || fail 'Depot multi-platform publication failed'
grep -Fxq "$IMAGE:edge" "$PUSHED" || fail 'current main did not publish edge'
grep -Fxq "$IMAGE@sha256:$one" "$PUSHED" || fail 'source digest was not used'
grep -Eq '^digest=sha256:[a-f0-9]{64}$' "$GITHUB_OUTPUT" || fail 'attestation digest was not returned'

: > "$DIGESTS_DIRECTORY/$two"
publish || fail 'native architecture publication failed'
grep -Fxq "$IMAGE@sha256:$two" "$PUSHED" || fail 'second architecture was omitted'

MAIN_SHA=2222222222222222222222222222222222222222 publish || fail 'superseded main lost its commit publication'
grep -Fxq "$IMAGE:sha-$GITHUB_SHA" "$PUSHED" || fail 'superseded main lost its commit tag'
if grep -Fxq "$IMAGE:edge" "$PUSHED"; then fail 'superseded main moved edge'; fi

export GITHUB_REF=refs/tags/v1.2.3
export TAGS="$IMAGE:v1.2.3"$'\n'"$IMAGE:v1.2"$'\n'"$IMAGE:latest"
FAIL_MAIN=1 publish || fail 'release publication unnecessarily depends on main'
for tag in v1.2.3 v1.2 latest; do
  grep -Fxq "$IMAGE:$tag" "$PUSHED" || fail "release tag $tag was lost"
done

for failure in FAIL_DRY_RUN FAIL_PUSH FAIL_INSPECT; do
  export "$failure=1"
  publish && fail "$failure was ignored"
  [[ ! -s "$GITHUB_OUTPUT" ]] || fail "$failure returned a successful attestation digest"
  unset "$failure"
done

# Invalid inputs must fail before any public tag is written.
export GITHUB_REF=refs/heads/main
FAIL_MAIN=1 publish && fail 'main lookup failure was ignored'
[[ ! -e "$PUSHED" ]] || fail 'published after a failed main lookup'
printf '{"manifests":[{"platform":{"os":"linux","architecture":"amd64"}}]}' > "$MANIFEST"
publish && fail 'missing arm64 passed validation'
[[ ! -e "$PUSHED" ]] || fail 'incomplete manifest was tagged'
rm "$DIGESTS_DIRECTORY/"*
publish && fail 'empty digest directory passed validation'
touch "$DIGESTS_DIRECTORY/invalid"
publish && fail 'malformed digest passed validation'
echo 'Image publication smoke passed.'
