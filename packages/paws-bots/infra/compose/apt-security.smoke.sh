#!/usr/bin/env bash
# Version gate for CVE-2026-109518. No network and no image build.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
# The computer, Compose, and desktop image builds each have their own context,
# so each directory keeps a copy. They have to stay the same file.
cmp -s "$root/../sandboxes/computer/apt-security.sh" "$root/apt-security.sh"
cmp -s "$root/../sandboxes/computer/apt-security.sh" "$root/../sandboxes/desktop/apt-security.sh"
# shellcheck disable=SC1091
source "$root/../sandboxes/computer/apt-security.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }

expect_ok() {
  apt_security_version_ok "$1" "$2" || fail "expected $1 $2 to pass"
}

expect_vulnerable() {
  if apt_security_version_ok "$1" "$2"; then
    fail "expected $1 $2 to fail"
  fi
}

expect_unknown() {
  if apt_security_floor "$1" >/dev/null 2>&1; then
    fail "expected no floor for '$1'"
  fi
}

expect_vulnerable bookworm 2.6.1
expect_vulnerable bookworm "2.6.1+deb12u1"
expect_vulnerable bookworm "2.6.2~deb12u1"
expect_ok bookworm 2.6.2
expect_ok bookworm "2.6.2+b1"
expect_ok bookworm 2.6.10
expect_vulnerable trixie 3.0.3
expect_ok trixie 3.0.4
expect_ok trixie "3.0.4+b1"
# 3.0.3 is newer than bookworm's floor and still vulnerable on trixie.
dpkg --compare-versions 3.0.3 ge 2.6.2 || fail "3.0.3 should sort after 2.6.2"
expect_unknown sid
expect_unknown forky
expect_unknown ""
expect_vulnerable bookworm ""

expect_selected() {
  apt_security_package_selected "$1" || fail "expected package $1 to be checked"
}
expect_ignored() {
  if apt_security_package_selected "$1"; then
    fail "expected package $1 to be ignored"
  fi
}
expect_selected apt
expect_selected apt-utils
expect_selected libapt-pkg6.0
expect_selected libapt-pkg7.0
expect_selected libapt-pkg6.0t64
expect_selected "libapt-pkg7.0t64:arm64"
expect_ignored aptitude
expect_ignored libapt-pkg-dev
expect_ignored bash

echo "apt-security smoke passed"
