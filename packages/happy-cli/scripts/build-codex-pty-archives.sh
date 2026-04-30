#!/usr/bin/env bash
set -euo pipefail

# Build `codex-pty` for all happy-cli tool platforms and package into tools/archives/.
#
# Requirements:
# - rustup
# - cargo-zigbuild (`cargo install cargo-zigbuild --locked`)
# - nix (used to provide `zig`)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_SRC_DIR="$ROOT_DIR/tools-src/codex-pty"
ARCHIVES_DIR="$ROOT_DIR/tools/archives"

cd "$TOOLS_SRC_DIR"

mkdir -p "$ARCHIVES_DIR"

if ! command -v cargo-zigbuild >/dev/null 2>&1; then
  echo "cargo-zigbuild not found; installing..." >&2
  cargo install cargo-zigbuild --locked
fi

# Keep zig out of the global environment.
ZIG_SHELL=(nix shell nixpkgs#zig -c)

# Ensure rust targets exist.
rustup target add \
  aarch64-apple-darwin \
  x86_64-apple-darwin \
  aarch64-unknown-linux-musl \
  x86_64-unknown-linux-musl \
  aarch64-pc-windows-gnullvm \
  x86_64-pc-windows-gnu

# Darwin
"${ZIG_SHELL[@]}" cargo zigbuild --release --target aarch64-apple-darwin
"${ZIG_SHELL[@]}" cargo zigbuild --release --target x86_64-apple-darwin

# Linux (musl)
"${ZIG_SHELL[@]}" cargo zigbuild --release --target aarch64-unknown-linux-musl
"${ZIG_SHELL[@]}" cargo zigbuild --release --target x86_64-unknown-linux-musl

# Windows needs `synchronization` import libs (Rust std links it).
# Zig ships the .def for the underlying API set DLL but not the import lib name.
ZIG_ENV_JSON="$(${ZIG_SHELL[@]} zig env)"
ZIG_LIB_DIR="$(printf '%s' "$ZIG_ENV_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["lib_dir"])')"
SYNCH_DEF="$ZIG_LIB_DIR/libc/mingw/lib-common/api-ms-win-core-synch-l1-2-0.def"

TMP_WINLIB="$(mktemp -d)"
trap 'rm -rf "$TMP_WINLIB"' EXIT

mkdir -p "$TMP_WINLIB/x64" "$TMP_WINLIB/arm64"
cp "$SYNCH_DEF" "$TMP_WINLIB/x64/synchronization.def"
cp "$SYNCH_DEF" "$TMP_WINLIB/arm64/synchronization.def"

"${ZIG_SHELL[@]}" zig dlltool -d "$TMP_WINLIB/x64/synchronization.def" -l "$TMP_WINLIB/x64/libsynchronization.a" -m i386:x86-64
"${ZIG_SHELL[@]}" zig dlltool -d "$TMP_WINLIB/arm64/synchronization.def" -l "$TMP_WINLIB/arm64/libsynchronization.a" -m arm64

RUSTFLAGS="-L native=$TMP_WINLIB/x64" "${ZIG_SHELL[@]}" cargo zigbuild --release --target x86_64-pc-windows-gnu
RUSTFLAGS="-L native=$TMP_WINLIB/arm64" "${ZIG_SHELL[@]}" cargo zigbuild --release --target aarch64-pc-windows-gnullvm

# Package archives

tar -C target/aarch64-apple-darwin/release -czf "$ARCHIVES_DIR/codex-pty-arm64-darwin.tar.gz" codex-pty

tar -C target/x86_64-apple-darwin/release -czf "$ARCHIVES_DIR/codex-pty-x64-darwin.tar.gz" codex-pty

tar -C target/aarch64-unknown-linux-musl/release -czf "$ARCHIVES_DIR/codex-pty-arm64-linux.tar.gz" codex-pty

tar -C target/x86_64-unknown-linux-musl/release -czf "$ARCHIVES_DIR/codex-pty-x64-linux.tar.gz" codex-pty

tar -C target/aarch64-pc-windows-gnullvm/release -czf "$ARCHIVES_DIR/codex-pty-arm64-win32.tar.gz" codex-pty.exe

tar -C target/x86_64-pc-windows-gnu/release -czf "$ARCHIVES_DIR/codex-pty-x64-win32.tar.gz" codex-pty.exe

ls -lh "$ARCHIVES_DIR"/codex-pty-*.tar.gz
