#!/usr/bin/env bash

set -euo pipefail

readonly DIST_DIR="${1:-packages/happy-app/dist}"
readonly OSS_BUCKET="${PAWS_WEB_OSS_BUCKET:-happy-app-ota-jacky}"
readonly OSS_UPLOAD_ENDPOINT="${OSS_UPLOAD_ENDPOINT:-https://oss-cn-hangzhou.aliyuncs.com}"
readonly OSS_ADDRESSING_STYLE="${OSS_ADDRESSING_STYLE:-virtual}"

if [[ ! -f "$DIST_DIR/index.html" ]]; then
    echo "错误：未找到 $DIST_DIR/index.html。请先构建 Web。" >&2
    exit 1
fi

if ! command -v aliyun >/dev/null 2>&1 || ! aliyun ossutil --help >/dev/null 2>&1; then
    echo "错误：需要带 ossutil 子命令的 aliyun CLI。" >&2
    exit 1
fi

upload_directory() {
    local source_dir="$1"
    local destination="$2"

    if [[ -d "$source_dir" ]]; then
        echo "==> 上传 $source_dir 到 $destination"
        aliyun ossutil cp -r "$source_dir/" "$destination" --force \
            --endpoint "$OSS_UPLOAD_ENDPOINT" --addressing-style "$OSS_ADDRESSING_STYLE"
    fi
}

upload_file() {
    local source_file="$1"
    local destination="$2"

    if [[ -f "$source_file" ]]; then
        echo "==> 上传 $source_file 到 $destination"
        aliyun ossutil cp "$source_file" "$destination" --force \
            --endpoint "$OSS_UPLOAD_ENDPOINT" --addressing-style "$OSS_ADDRESSING_STYLE"
    fi
}

upload_directory "$DIST_DIR/_expo" "oss://$OSS_BUCKET/_expo/"
upload_directory "$DIST_DIR/assets" "oss://$OSS_BUCKET/assets/"

for filename in canvaskit.wasm favicon.ico favicon-active.ico metadata.json; do
    upload_file "$DIST_DIR/$filename" "oss://$OSS_BUCKET/$filename"
done
