#!/bin/sh
# Paws isolated computers use chrome-use, never the upstream browser binary.
set -eu
dest="${1:?usage: install-chrome-use.sh <folder>}"
version=1.5.291
if [ -x "$dest/chrome-use" ] && "$dest/chrome-use" --version 2>/dev/null | head -1 | grep -qx "chrome-use $version"; then exit 0; fi
case "$(uname -m)" in
 aarch64|arm64) arch=arm64; sha256=faccaa543990afff07fb0a769fb2e8f5d17688dd95f6f71857780228e905f1ba ;;
 x86_64|amd64) arch=x64; sha256=d6976d5931b620fa82bccf8a8743668f4066f5927567f6a7e87c770534db43ec ;;
 *) echo "Unsupported computer architecture" >&2; exit 1 ;;
esac
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL --retry 3 --max-time 180 "https://github.com/leeguooooo/chrome-use/releases/download/v$version/chrome-use-linux-$arch.tar.gz" -o "$work/release.tar.gz"
echo "$sha256  $work/release.tar.gz" | sha256sum -c -
tar -xzf "$work/release.tar.gz" -C "$work"
mkdir -p "$dest" /usr/share/doc/chrome-use
install -m 755 "$work/chrome-use" "$dest/chrome-use"
cp "$work"/LICENSE* /usr/share/doc/chrome-use/
