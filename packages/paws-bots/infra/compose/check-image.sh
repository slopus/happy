#!/usr/bin/env bash
# Fails when a built image carries a credential or checkout state: a .env file, a .git directory, a
# private key file, or a PEM private key in the app tree. CI runs it on the app image before any tag
# points at it. Third-party packages under node_modules are skipped; they are not ours to vet.
#
# Usage: check-image.sh ROOTFS_TAR
#        check-image.sh IMAGE [PLATFORM]
# A filesystem tar written by the build avoids pulling a multi-gigabyte image back from the registry.
set -euo pipefail

source="${1:?Usage: check-image.sh ROOTFS_TAR | IMAGE [PLATFORM]}"
platform="${2:-linux/amd64}"
work="$(mktemp -d)"
container=""
ref="${source}"
cleanup() {
  [[ -z "${container}" ]] || docker rm --force "${container}" >/dev/null 2>&1 || true
  [[ "${ref}" == "${source}" ]] || docker rmi "${ref}" >/dev/null 2>&1 || true
  rm -rf "${work}"
}
trap cleanup EXIT

if [[ -f "${source}" ]]; then
  rootfs="${source}"
else
  # Check the platform's own manifest rather than the multi-platform list: the Docker image store
  # refuses to pull one list a second time for another platform. A single-platform image is used as is.
  if raw="$(docker buildx imagetools inspect --raw "${source}" 2>/dev/null)" &&
    [[ "$(jq -r '.manifests | type' <<<"${raw}")" == array ]]; then
    digest="$(jq -r --arg os "${platform%%/*}" --arg arch "${platform#*/}" \
      'first(.manifests[] | select(.platform.os == $os and .platform.architecture == $arch) | .digest) // empty' \
      <<<"${raw}")"
    [[ -n "${digest}" ]] || { echo "${source} has no ${platform} image." >&2; exit 1; }
    repository="${source%@*}"
    [[ "${repository##*/}" != *:* ]] || repository="${repository%:*}"
    ref="${repository}@${digest}"
  fi
  container="$(docker create --quiet --platform "${platform}" "${ref}")"
  rootfs="${work}/rootfs.tar"
  docker export "${container}" >"${rootfs}"
fi

tar -tf "${rootfs}" | sed "s|^\./||" >"${work}/all"
grep -Ev "(^|/)node_modules/" "${work}/all" >"${work}/files" || true
found="$(grep -E \
  -e '(^|/)\.git(/|$)' \
  -e '(^|/)\.env(\.[^/]*)?$' \
  -e '(^|/)id_(rsa|ecdsa|ed25519)$' \
  -e '^app/.*\.(pem|key|p12|pfx)$' \
  "${work}/files" | grep -Ev '\.example$' || true)"

# A key header followed by a base64 body. Bundled code may mention the header in a string literal,
# but never with a key body on the next line.
mkdir "${work}/app"
tar -xf "${rootfs}" -C "${work}/app" --exclude=node_modules app
while IFS= read -r file; do
  if awk '/-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY-----/ {
        if ((getline body) > 0 && body ~ /^[A-Za-z0-9+\/=]{40,}$/) { found = 1; exit }
      } END { exit !found }' "${file}"; then
    found+="${found:+$'\n'}${file#"${work}/app/"}"
  fi
done < <(grep -rlE -- '-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY-----' "${work}/app" 2>/dev/null || true)

if [[ -n "${found}" ]]; then
  echo "${source} contains files that must not ship:" >&2
  sed "s/^/  /" <<<"${found}" >&2
  exit 1
fi
echo "${source} contains no credentials or checkout state."
