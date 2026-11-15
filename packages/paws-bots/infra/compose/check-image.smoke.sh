#!/usr/bin/env bash
# check-image.sh against prepared filesystems, as tars and through a fake Docker CLI; no daemon.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

mkdir -p "$scratch/bin"
cat >"$scratch/bin/docker" <<'FAKE'
#!/usr/bin/env bash
case "$1" in
  buildx)
    # A multi-platform list when INDEX names one; otherwise a single-platform image.
    [[ -n "${INDEX:-}" ]] || exit 1
    cat "$INDEX"
    ;;
  create)
    ref="${!#}"
    # Like the containerd image store: one pull per reference, so a second platform of the same
    # list fails with "cannot overwrite digest".
    if grep -qxF "$ref" "$CREATED" 2>/dev/null; then echo "cannot overwrite digest" >&2; exit 1; fi
    echo "$ref" >>"$CREATED"
    echo fake-container
    ;;
  export) [[ -z "${FAIL_EXPORT:-}" ]] && tar -c -C "$IMAGE_ROOT" app ;;  # no ./ prefix, like docker
  rm | rmi) ;;
  *) exit 1 ;;
esac
FAKE
chmod +x "$scratch/bin/docker"

key_body="$(printf 'A%.0s' {1..64})"
# A clean image: a header in bundled code, third-party fixtures, and example env files.
image() {
  local dir="$scratch/$1"
  mkdir -p "$dir/app/apps/api/dist" "$dir/app/node_modules/pkg/test" "$dir/app/infra/compose"
  printf 'const h = "-----BEGIN PRIVATE KEY-----\\n";\n' >"$dir/app/apps/api/dist/index.js"
  printf -- '-----BEGIN PRIVATE KEY-----\n%s\n' "$key_body" >"$dir/app/node_modules/pkg/test/key.pem"
  touch "$dir/app/node_modules/pkg/.env" "$dir/app/.env.example" "$dir/app/infra/compose/.env.images.example"
  echo "$dir"
}
check() {
  rm -f "$scratch/created"
  PATH="$scratch/bin:$PATH" IMAGE_ROOT="$1" CREATED="$scratch/created" \
    bash "$root/check-image.sh" "${2:-example/app:test}" "${3:-linux/amd64}" 2>&1
}

clean="$(image clean)"
check "$clean" >/dev/null || fail "a clean image was rejected: $(check "$clean")"
FAIL_EXPORT=1 check "$clean" >/dev/null && fail "a failed export passed the check"

# Both platforms of one multi-platform list, each checked through its own manifest.
cat >"$scratch/index.json" <<'JSON'
{"manifests": [
  {"digest": "sha256:amd", "platform": {"os": "linux", "architecture": "amd64"}},
  {"digest": "sha256:arm", "platform": {"os": "linux", "architecture": "arm64", "variant": "v8"}},
  {"digest": "sha256:att", "platform": {"os": "unknown", "architecture": "unknown"}}
]}
JSON
export INDEX="$scratch/index.json"
list="registry.example.test:5000/rakazo/app@sha256:list"
: >"$scratch/all-created"
for platform in linux/amd64 linux/arm64; do
  output="$(check "$clean" "$list" "$platform")" || fail "$platform of a list: $output"
  cat "$scratch/created" >>"$scratch/all-created"
done
[[ "$(cat "$scratch/all-created")" == $'registry.example.test:5000/rakazo/app@sha256:amd\nregistry.example.test:5000/rakazo/app@sha256:arm' ]] ||
  fail "did not check each platform's own manifest: $(cat "$scratch/all-created")"
output="$(check "$clean" "$list" linux/s390x)" && fail "a platform missing from the list passed"
grep -q "has no linux/s390x image" <<<"$output" || fail "unexpected output: $output"
unset INDEX

# A filesystem tar from the build, with no Docker involved.
check_tar() {
  tar -c -f "$1.tar" -C "$1" app  # no ./ prefix, like BuildKit's tar exporter
  PATH="$scratch/bin:$PATH" CREATED="$scratch/created" bash "$root/check-image.sh" "$1.tar" 2>&1
}
rm -f "$scratch/created"
check_tar "$clean" >/dev/null || fail "a clean tar was rejected: $(check_tar "$clean")"
[[ ! -e "$scratch/created" ]] || fail "a tar check pulled an image"

for case in env git key-file key-body; do
  dir="$(image "$case")"
  case "$case" in
    env) touch "$dir/app/.env.production" ;;
    git) mkdir -p "$dir/app/.git" && touch "$dir/app/.git/HEAD" ;;
    key-file) touch "$dir/app/deploy.pem" ;;
    key-body) printf -- '-----BEGIN OPENSSH PRIVATE KEY-----\n%s\n' "$key_body" >"$dir/app/notes.txt" ;;
  esac
  for checker in check check_tar; do
    if output="$($checker "$dir")"; then
      fail "$case: $checker passed an image with a secret"
    fi
    grep -q "must not ship" <<<"$output" || fail "$case: unexpected $checker output: $output"
  done
done

echo "check-image smoke passed"
