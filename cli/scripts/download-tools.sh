#!/bin/sh
# download-tools.sh - fetch difftastic and ripgrep binaries
# usage: download-tools.sh [platform ...]
#        download-tools.sh all

die() {
	echo "$*" >&2
	exit 1
}

# versions
difft_ver=0.67.0
rg_ver=15.1.0

# where we are
dir=$(cd "$(dirname "$0")" && pwd)
archives="$dir/../tools/archives"
tmp="${TMPDIR:-/tmp}/dl-tools.$$"

trap 'rm -rf "$tmp"' EXIT INT TERM

mkdir -p "$tmp" "$archives"

# map our platform names to upstream naming conventions
difft_upstream() {
	case "$1" in
	arm64-darwin) echo aarch64-apple-darwin ;;
	x64-darwin)   echo x86_64-apple-darwin ;;
	arm64-linux)  echo aarch64-unknown-linux-gnu ;;
	x64-linux)    echo x86_64-unknown-linux-gnu ;;
	x64-win32)    echo x86_64-pc-windows-msvc ;;
	arm64-win32)  echo aarch64-pc-windows-msvc ;;
	*) return 1 ;;
	esac
}

rg_upstream() {
	case "$1" in
	arm64-darwin) echo aarch64-apple-darwin ;;
	x64-darwin)   echo x86_64-apple-darwin ;;
	arm64-linux)  echo aarch64-unknown-linux-gnu ;;
	x64-linux)    echo x86_64-unknown-linux-gnu ;;
	x64-win32)    echo x86_64-pc-windows-msvc ;;
	arm64-win32)  echo aarch64-pc-windows-msvc ;;
	*) return 1 ;;
	esac
}

# @anthropic-ai/ripgrep-* package names
rgnode_pkg() {
	case "$1" in
	arm64-darwin) echo darwin-arm64 ;;
	x64-darwin)   echo darwin-x64 ;;
	arm64-linux)  echo linux-arm64-gnu ;;
	x64-linux)    echo linux-x64-gnu ;;
	x64-win32)    echo win32-x64-msvc ;;
	arm64-win32)  echo win32-arm64-msvc ;;
	*) return 1 ;;
	esac
}

iswin() {
	case "$1" in *win32) return 0 ;; esac
	return 1
}

fetch_difft() {
	plat=$1
	up=$(difft_upstream "$plat") || return 1

	if iswin "$plat"; then
		bin=difft.exe
		ext=zip
	else
		bin=difft
		ext=tar.gz
	fi

	url="https://github.com/Wilfred/difftastic/releases/download/${difft_ver}/difft-${up}.${ext}"
	out="$archives/difftastic-${plat}.tar.gz"

	echo "difft $plat: $url"

	mkdir -p "$tmp/difft-$plat"

	if test "$ext" = "zip"; then
		curl -fsSL "$url" -o "$tmp/difft-$plat.zip" || return 1
		unzip -q "$tmp/difft-$plat.zip" -d "$tmp/difft-$plat"
	else
		curl -fsSL "$url" | tar -xzf - -C "$tmp/difft-$plat" || return 1
	fi

	found=$(find "$tmp/difft-$plat" -name "$bin" -type f | head -1)
	test -n "$found" || { echo "no $bin found" >&2; return 1; }

	mkdir -p "$tmp/difft-pack-$plat"
	cp "$found" "$tmp/difft-pack-$plat/$bin"
	tar -czf "$out" -C "$tmp/difft-pack-$plat" "$bin"

	echo "  -> $out"
}

fetch_rg() {
	plat=$1
	up=$(rg_upstream "$plat") || return 1

	if iswin "$plat"; then
		bin=rg.exe
		ext=zip
	else
		bin=rg
		ext=tar.gz
	fi

	url="https://github.com/BurntSushi/ripgrep/releases/download/${rg_ver}/ripgrep-${rg_ver}-${up}.${ext}"
	out="$archives/ripgrep-${plat}.tar.gz"

	echo "rg $plat: $url"

	mkdir -p "$tmp/rg-$plat"

	if test "$ext" = "zip"; then
		curl -fsSL "$url" -o "$tmp/rg-$plat.zip" || return 1
		unzip -q "$tmp/rg-$plat.zip" -d "$tmp/rg-$plat"
	else
		curl -fsSL "$url" | tar -xzf - -C "$tmp/rg-$plat" || return 1
	fi

	found=$(find "$tmp/rg-$plat" -name "$bin" -type f | head -1)
	test -n "$found" || { echo "no $bin found" >&2; return 1; }

	mkdir -p "$tmp/rg-pack-$plat"
	cp "$found" "$tmp/rg-pack-$plat/$bin"

	# try to get ripgrep.node from npm
	npkg=$(rgnode_pkg "$plat") || true
	if test -n "$npkg"; then
		mkdir -p "$tmp/rgnode-$plat"
		if npm pack "@anthropic-ai/ripgrep-${npkg}" --pack-destination "$tmp/rgnode-$plat" 2>/dev/null; then
			tgz=$(ls "$tmp/rgnode-$plat"/*.tgz 2>/dev/null | head -1)
			if test -n "$tgz"; then
				tar -xzf "$tgz" -C "$tmp/rgnode-$plat"
				node=$(find "$tmp/rgnode-$plat" -name "ripgrep.node" -type f | head -1)
				if test -n "$node"; then
					cp "$node" "$tmp/rg-pack-$plat/ripgrep.node"
					echo "  + ripgrep.node"
				fi
			fi
		fi
	fi

	tar -czf "$out" -C "$tmp/rg-pack-$plat" .

	echo "  -> $out"
}

fetch_platform() {
	plat=$1
	echo "=== $plat ==="
	fetch_difft "$plat" || echo "  difft failed"
	fetch_rg "$plat" || echo "  rg failed"
	echo
}

# main
case "$1" in
""|"-h"|"--help")
	cat <<EOF
usage: $0 [platform ...]
       $0 all

platforms: arm64-darwin x64-darwin arm64-linux x64-linux x64-win32 arm64-win32
EOF
	exit 0
	;;
all)
	for p in arm64-darwin x64-darwin arm64-linux x64-linux x64-win32 arm64-win32; do
		fetch_platform "$p"
	done
	;;
*)
	for p in "$@"; do
		fetch_platform "$p"
	done
	;;
esac
