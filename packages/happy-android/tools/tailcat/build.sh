#!/usr/bin/env bash
# Builds tailcat-kotlin's JVM jar from its pinned commit into the repo-local
# Maven repository the app resolves io.tailcat from (vendor/maven). The JVM
# variant is the Android one too: both compile the same commonMain and
# jvmAndAndroidMain sources (JDK sockets and TLS, kotlin-stdlib only).
# tailcat-kotlin publishes no artifact yet; when it does, point the version
# catalog at it and delete vendor/maven and this script.
set -euo pipefail
COMMIT=4f041f4754f9cf4e52b26cc41173ef9903f86c76
VERSION=0.1.0-${COMMIT:0:7}
here="$(cd "$(dirname "$0")" && pwd)"
android="$(cd "$here/../.." && pwd)"
work="${TAILCAT_WORK:-$android/build/tailcat-kotlin}"
rm -rf "$work"
git clone --quiet https://github.com/slopus/tailcat-kotlin.git "$work"
git -C "$work" checkout --quiet "$COMMIT"
(cd "$work" && ./gradlew --no-daemon -q jvmJar)
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
  "  <description>slopus/tailcat-kotlin $COMMIT, JVM variant</description>" \
  '  <licenses><license><name>BSD-3-Clause</name></license></licenses>' \
  '</project>' > "$dest/tailcat-kotlin-$VERSION.pom"
cp "$work/LICENSE" "$android/vendor/maven/io/tailcat/LICENSE"
(cd "$dest" && shasum -a 256 "tailcat-kotlin-$VERSION.jar" > SHA256SUMS)
echo "io.tailcat:tailcat-kotlin:$VERSION"
