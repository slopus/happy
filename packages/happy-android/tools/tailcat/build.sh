#!/usr/bin/env bash
# Builds tailcat-kotlin's JVM jar from its pinned commit into the repo-local
# Maven repository the app resolves io.tailcat from (vendor/maven). The JVM
# variant is the Android one too: both compile the same commonMain and
# jvmAndAndroidMain sources (JDK sockets and TLS, kotlin-stdlib only).
# tailcat-kotlin publishes no artifact yet; when it does, point the version
# catalog at it and delete vendor/maven and this script.
#
# patches/*.patch are applied on top of the commit, in order, and named in
# the version (-p<count>). They are fixes not yet in tailcat-kotlin itself;
# drop each one once the pinned commit has it. There are none today.
set -euo pipefail
COMMIT=705a8682c5ff954b8758f8fa9d91168e9d4612d1
here="$(cd "$(dirname "$0")" && pwd)"
patches=("$here"/patches/*.patch)
[ -e "${patches[0]}" ] || patches=()
VERSION=0.1.0-${COMMIT:0:7}${patches:+-p${#patches[@]}}
android="$(cd "$here/../.." && pwd)"
work="${TAILCAT_WORK:-$android/build/tailcat-kotlin}"
rm -rf "$work"
git clone --quiet https://github.com/slopus/tailcat-kotlin.git "$work"
git -C "$work" checkout --quiet "$COMMIT"
for patch in "${patches[@]}"; do git -C "$work" apply "$patch"; done
(cd "$work" && ./gradlew --no-daemon -q jvmTest jvmJar)
dest="$android/vendor/maven/io/tailcat/tailcat-kotlin/$VERSION"
mkdir -p "$dest"
cp "$work/build/libs/tailcat-kotlin-jvm-0.1.0.jar" "$dest/tailcat-kotlin-$VERSION.jar"
printf '%s\n' \
  '<?xml version="1.0" encoding="UTF-8"?>' \
  '<project xmlns="http://maven.apache.org/POM/4.0.0">' \
  '  <modelVersion>4.0.0</modelVersion>' \
  '  <groupId>io.tailcat</groupId>' \
  '  <artifactId>tailcat-kotlin</artifactId>' \
  "  <version>$VERSION</version>" \
  "  <description>slopus/tailcat-kotlin $COMMIT with ${#patches[@]} patch(es) from tools/tailcat/patches, JVM variant</description>" \
  '  <licenses><license><name>BSD-3-Clause</name></license></licenses>' \
  '</project>' > "$dest/tailcat-kotlin-$VERSION.pom"
cp "$work/LICENSE" "$android/vendor/maven/io/tailcat/LICENSE"
(cd "$dest" && shasum -a 256 "tailcat-kotlin-$VERSION.jar" > SHA256SUMS)
echo "io.tailcat:tailcat-kotlin:$VERSION"
