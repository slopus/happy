#!/usr/bin/env bash

set -euo pipefail

readonly DIST_DIR="${1:-packages/happy-app/dist}"
readonly OSS_BUCKET="${PAWS_WEB_OSS_BUCKET:-happy-app-ota-jacky}"
readonly OSS_UPLOAD_ENDPOINT="${OSS_UPLOAD_ENDPOINT:-https://oss-cn-hangzhou.aliyuncs.com}"
readonly OSS_ADDRESSING_STYLE="${OSS_ADDRESSING_STYLE:-virtual}"
readonly RELEASE_MARKER="$DIST_DIR/.paws-release-revision"
readonly IMMUTABLE_CACHE_CONTROL="public,max-age=31536000,immutable"
readonly REVALIDATE_CACHE_CONTROL="no-cache"

if [[ ! -f "$DIST_DIR/index.html" ]]; then
    echo "错误：未找到 $DIST_DIR/index.html。请先构建 Web。" >&2
    exit 1
fi

if [[ ! -f "$RELEASE_MARKER" ]]; then
    echo "错误：未找到 $RELEASE_MARKER。" >&2
    exit 1
fi
RELEASE_REVISION="$(tr -d '[:space:]' < "$RELEASE_MARKER")"
if [[ ! "$RELEASE_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
    echo "错误：Web release marker 必须是 40-character lowercase Git SHA。" >&2
    exit 1
fi

if ! command -v aliyun >/dev/null 2>&1 || ! aliyun ossutil --help >/dev/null 2>&1; then
    echo "错误：需要带 ossutil 子命令的 aliyun CLI。" >&2
    exit 1
fi

upload_directory() {
    local source_dir="$1"
    local destination="$2"
    local cache_control="$3"

    if [[ -d "$source_dir" ]]; then
        echo "==> 上传 $source_dir 到 $destination"
        aliyun ossutil cp -r "$source_dir/" "$destination" --force \
            --cache-control "$cache_control" \
            --endpoint "$OSS_UPLOAD_ENDPOINT" --addressing-style "$OSS_ADDRESSING_STYLE"
    fi
}

upload_file() {
    local source_file="$1"
    local destination="$2"
    local cache_control="$3"
    local content_type="${4:-}"

    if [[ -f "$source_file" ]]; then
        echo "==> 上传 $source_file 到 $destination"
        if [[ -n "$content_type" ]]; then
            aliyun ossutil cp "$source_file" "$destination" --force \
                --cache-control "$cache_control" --content-type "$content_type" \
                --endpoint "$OSS_UPLOAD_ENDPOINT" --addressing-style "$OSS_ADDRESSING_STYLE"
        else
            aliyun ossutil cp "$source_file" "$destination" --force \
                --cache-control "$cache_control" \
                --endpoint "$OSS_UPLOAD_ENDPOINT" --addressing-style "$OSS_ADDRESSING_STYLE"
        fi
    fi
}

echo "==> 上传完整不可变 Web release ${RELEASE_REVISION:0:12}"
upload_directory \
    "$DIST_DIR" \
    "oss://$OSS_BUCKET/web/releases/$RELEASE_REVISION/" \
    "$IMMUTABLE_CACHE_CONTROL"

upload_directory "$DIST_DIR/_expo" "oss://$OSS_BUCKET/_expo/" "$IMMUTABLE_CACHE_CONTROL"
upload_directory "$DIST_DIR/assets" "oss://$OSS_BUCKET/assets/" "$IMMUTABLE_CACHE_CONTROL"

for source_file in "$DIST_DIR/.well-known"/*; do
    [[ -f "$source_file" ]] || continue
    filename="$(basename -- "$source_file")"
    upload_file "$source_file" "oss://$OSS_BUCKET/.well-known/$filename" "$REVALIDATE_CACHE_CONTROL" "application/json"
done

for source_file in "$DIST_DIR"/*; do
    if [[ -f "$source_file" && "$(basename -- "$source_file")" != "index.html" ]]; then
        filename="$(basename -- "$source_file")"
        upload_file "$source_file" "oss://$OSS_BUCKET/$filename" "$REVALIDATE_CACHE_CONTROL"
    fi
done

echo "==> OSS immutable release 已上传，等待公开 HTTP 预激活验证：$RELEASE_REVISION"
