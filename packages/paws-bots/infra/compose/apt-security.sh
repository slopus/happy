#!/usr/bin/env bash
# Install apt from Debian's signed archive and fail if the image would still
# ship a vulnerable version. Bookworm is fixed in 2.6.2 (DLA-4880-1) and trixie
# in 3.0.4 (DSA-6607-1). Both are native versions with no Debian revision.
# dpkg comparison is required: 3.0.3 sorts after 2.6.2 and is still vulnerable,
# and a revision of 2.6.1 such as 2.6.1+deb12u1 stays older than 2.6.2.
set -euo pipefail

apt_security_floor() {
  case "$1" in
    bookworm) printf '%s\n' 2.6.2 ;;
    trixie) printf '%s\n' 3.0.4 ;;
    *)
      echo "apt security check: no fixed apt version recorded for Debian release '$1'." >&2
      return 1
      ;;
  esac
}

apt_security_version_ok() {
  local floor
  floor="$(apt_security_floor "$1")"
  dpkg --compare-versions "$2" ge "$floor"
}

# t64 is the time_t ABI suffix. A name like libapt-pkg6.0t64 is still the apt library.
apt_security_package_re='^(apt|apt-utils|libapt-pkg[0-9.]+(t64)?)(:[a-zA-Z0-9]+)?$'

apt_security_package_selected() {
  [[ "$1" =~ $apt_security_package_re ]]
}

apt_security_installed_packages() {
  local pkg
  while read -r pkg; do
    [[ -n "$pkg" ]] || continue
    apt_security_package_selected "$pkg" && printf '%s\n' "$pkg"
  done < <(dpkg-query -W -f '${Package}\n' 2>/dev/null || true)
}

apt_security_codename() {
  local release="${APT_SECURITY_OS_RELEASE:-/etc/os-release}" codename
  # shellcheck disable=SC1090
  codename="$(. "$release" && printf '%s' "${VERSION_CODENAME:-}")"
  [[ -n "$codename" ]] || { echo "apt security check: Debian codename is missing." >&2; exit 1; }
  printf '%s\n' "$codename"
}

apt_security_require() {
  local codename="$1" pkg="$2" version="$3" floor="$4"
  if ! dpkg --compare-versions "$version" ge "$floor"; then
    echo "apt security check: ${codename} ${pkg} ${version} is older than ${floor}." >&2
    exit 1
  fi
}

apt_security_assert_installed() {
  local codename floor pkg version
  codename="$(apt_security_codename)"
  floor="$(apt_security_floor "$codename")"
  version="$(dpkg-query -W -f '${Version}' apt 2>/dev/null || true)"
  [[ -n "$version" ]] || { echo "apt security check: apt is not installed." >&2; exit 1; }
  apt_security_require "$codename" apt "$version" "$floor"
  while read -r pkg; do
    [[ -n "$pkg" && "$pkg" != apt ]] || continue
    version="$(dpkg-query -W -f '${Version}' "$pkg")"
    apt_security_require "$codename" "$pkg" "$version" "$floor"
  done < <(apt_security_installed_packages)
}

apt_security_upgrade() {
  local pkg pkgs=()
  export DEBIAN_FRONTEND=noninteractive
  # The vulnerable client is reachable when a download is retried. Do not retry
  # while that client is fetching its replacement. The setting is not saved.
  apt-get -o Acquire::Retries=0 update
  while read -r pkg; do
    [[ -n "$pkg" ]] || continue
    pkgs+=("$pkg")
  done < <(apt_security_installed_packages)
  [[ ${#pkgs[@]} -gt 0 ]] || { echo "apt security check: apt is not installed." >&2; exit 1; }
  apt-get -o Acquire::Retries=0 install -y --no-install-recommends --only-upgrade "${pkgs[@]}"
  rm -rf /var/lib/apt/lists/*
  apt_security_assert_installed
}

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

case "${1:-}" in
  --check) apt_security_assert_installed ;;
  "") apt_security_upgrade ;;
  *)
    echo "usage: apt-security.sh [--check]" >&2
    exit 2
    ;;
esac
