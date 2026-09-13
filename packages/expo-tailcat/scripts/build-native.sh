#!/usr/bin/env bash
set -euo pipefail
package_dir="$(cd "$(dirname "$0")/.." && pwd)"
platform="${1:?Usage: build-native.sh ios|android}"
cd "$package_dir/go"
export GOBIN="$package_dir/build/tools"
export PATH="$GOBIN:$PATH"
mkdir -p "$GOBIN"
# Versions are tool dependencies pinned in go.mod/go.sum.
go install golang.org/x/mobile/cmd/gobind golang.org/x/mobile/cmd/gomobile
# Build only the transport. Do not link CLI tools or the private test fixture.
# Keep the OS resolver: forcing netgo breaks Android system DNS and bypasses
# Apple's native resolver. The desktop Tailcat release tags are not mobile-safe.
tags="$(tr -d '\n' < "$package_dir/native-tags.txt")"
case "$platform" in
  ios)
    if [[ "$(uname -s)" != Darwin ]]; then
      echo 'An Apple SDK on macOS is required to build the iOS XCFramework.' >&2
      exit 1
    fi
    mkdir -p "$package_dir/ios/Frameworks"
    gomobile bind -target=ios,iossimulator -iosversion=15.1 -prefix=Tailcat \
      -tags="$tags" -ldflags='-s -w' \
      -o "$package_dir/ios/Frameworks/Tailcat.xcframework" ./mobile
    ;;
  android)
    : "${ANDROID_HOME:?Set ANDROID_HOME to an Android SDK with an installed NDK}"
    mkdir -p "$package_dir/android/libs"
    # arm64 devices + x86_64 emulator; avoid spending time on obsolete 32-bit ABIs.
    # Modern NDK + explicit alignment support Android's 16 KB memory pages.
    gomobile bind -target=android/arm64,android/amd64 -androidapi=26 \
      -tags="$tags" -ldflags='-s -w -extldflags=-Wl,-z,max-page-size=16384' \
      -o "$package_dir/android/libs/ExpoTailcat.aar" ./mobile
    ;;
  *) echo "Unknown platform: $platform" >&2; exit 1 ;;
esac