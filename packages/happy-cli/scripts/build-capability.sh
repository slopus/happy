#!/bin/sh
# Build the read-only macOS capability helper and package it for postinstall.
# Usage: build-capability.sh arm64-darwin [x64-darwin ...]

set -eu

dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$dir/.." && pwd)
source="$root/native/happy-capability.c"
archives="$root/tools/archives"
sdkroot=${SDKROOT:-}

if [ "$(uname -s)" != "Darwin" ]; then
    echo "macOS is required to build the IOKit helper" >&2
    exit 1
fi

if [ -z "$sdkroot" ]; then
    sdkroot=$(xcrun --sdk macosx --show-sdk-path)
fi

if [ "$#" -eq 0 ]; then
    set -- arm64-darwin x64-darwin
fi

mkdir -p "$archives"
build_root=$(mktemp -d "${TMPDIR:-/tmp}/happy-capability.XXXXXX")
trap 'rm -rf "$build_root"' EXIT INT TERM

for platform in "$@"; do
    case "$platform" in
        arm64-darwin) arch=arm64 ;;
        x64-darwin) arch=x86_64 ;;
        *) echo "unsupported platform: $platform" >&2; exit 1 ;;
    esac

    build_dir="$build_root/$platform"
    mkdir -p "$build_dir"
    /usr/bin/clang \
        -arch "$arch" \
        -mmacosx-version-min=10.15 \
        -std=c11 \
        -Wall -Wextra -Wpedantic \
        -O2 \
        -isysroot "$sdkroot" \
        "$source" \
        -framework IOKit \
        -framework CoreFoundation \
        -o "$build_dir/happy-capability"
    /usr/bin/codesign --force --sign - --timestamp=none "$build_dir/happy-capability"

    COPYFILE_DISABLE=1 tar -czf "$archives/happy-capability-$platform.tar.gz" \
        -C "$build_dir" happy-capability
    echo "created $archives/happy-capability-$platform.tar.gz"
done