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

# Validate every immutable skin URL before the first OSS write. The importer
# updates this manifest together with the hashed assets and runtime catalog.
skin_specs_text="$(node -e '
const manifest = require("./scripts/desktop-skin-assets.json");
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.skins) || manifest.skins.length < 2) process.exit(1);
for (const skin of manifest.skins) {
    if (!/^[a-z][a-z0-9-]*$/.test(skin.assetId) || !/^background\.[0-9a-f]{16}\.webp$/.test(skin.filename)) process.exit(1);
    console.log(skin.assetId + "/" + skin.filename);
}
')"
skin_count="$(find "$DIST_DIR/desktop-skins" -type f | wc -l | tr -d '[:space:]')"
skin_expected_count="$(printf '%s\n' "$skin_specs_text" | wc -l | tr -d '[:space:]')"
[[ "$skin_count" == "$skin_expected_count" ]] || { echo '错误：桌面皮肤背景资源数量不正确。' >&2; exit 1; }
skin_paths=()
while IFS= read -r skin_relative; do
    skin_id="${skin_relative%%/*}"
    expected_name="${skin_relative#*/}"
    skin_dir="$DIST_DIR/desktop-skins/$skin_id"
    [[ -d "$skin_dir" ]] || { echo "错误：缺少 $skin_id 背景资源。" >&2; exit 1; }
    skin_path="$(find "$skin_dir" -maxdepth 1 -type f -print)"
    [[ "$(printf '%s\n' "$skin_path" | sed '/^$/d' | wc -l | tr -d '[:space:]')" == 1 ]] || { echo "错误：$skin_id 背景资源数量不正确。" >&2; exit 1; }
    skin_name="${skin_path##*/}"
    [[ "$skin_name" == "$expected_name" && "$skin_name" =~ ^background\.([0-9a-f]{16})\.webp$ ]] || { echo "错误：$skin_id 背景文件名与清单不一致。" >&2; exit 1; }
    skin_hash_prefix="${BASH_REMATCH[1]}"
    skin_hash="$(shasum -a 256 "$skin_path" | cut -d ' ' -f 1)"
    [[ "${skin_hash:0:16}" == "$skin_hash_prefix" ]] || { echo "错误：$skin_id 背景文件名与内容 SHA-256 不一致。" >&2; exit 1; }
    skin_paths+=("$skin_path")
done <<< "$skin_specs_text"

if ! command -v aliyun >/dev/null 2>&1 || ! aliyun ossutil --help >/dev/null 2>&1; then
    echo "错误：需要带 ossutil 子命令的 aliyun CLI。" >&2
    exit 1
fi

upload_directory() {
    local source_dir="$1"
    local destination="$2"
    local cache_control="$3"

    if [[ -d "$source_dir" ]]; then
        echo "==> 校验并补传 $source_dir 到 $destination"
        node scripts/oss-upload-sync.cjs "$source_dir" "$OSS_BUCKET" \
            "${destination#"oss://$OSS_BUCKET/"}" "$cache_control"
    fi
}

copy_directory_with_checksum() {
    local source="$1"
    local destination="$2"
    echo "==> OSS 内部复用 $source 到 $destination"
    aliyun ossutil cp -r "$source" "$destination" --checksum --force \
        --endpoint "$OSS_UPLOAD_ENDPOINT" --addressing-style "$OSS_ADDRESSING_STYLE"
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

if [[ -d "$DIST_DIR/_expo" ]]; then
    copy_directory_with_checksum \
        "oss://$OSS_BUCKET/web/releases/$RELEASE_REVISION/_expo/" \
        "oss://$OSS_BUCKET/_expo/"
fi
if [[ -d "$DIST_DIR/assets" ]]; then
    copy_directory_with_checksum \
        "oss://$OSS_BUCKET/web/releases/$RELEASE_REVISION/assets/" \
        "oss://$OSS_BUCKET/assets/"
fi
for skin_path in "${skin_paths[@]}"; do
    skin_name="${skin_path##*/}"
    skin_id="$(basename "$(dirname "$skin_path")")"
    upload_file "$skin_path" "oss://$OSS_BUCKET/desktop-skins/$skin_id/$skin_name" "$IMMUTABLE_CACHE_CONTROL" "image/webp"
done

for source_file in "$DIST_DIR/.well-known"/*; do
    [[ -f "$source_file" ]] || continue
    filename="$(basename -- "$source_file")"
    upload_file "$source_file" "oss://$OSS_BUCKET/.well-known/$filename" "$REVALIDATE_CACHE_CONTROL" "application/json"
done

for source_file in "$DIST_DIR"/*; do
    if [[ -f "$source_file" && "$(basename -- "$source_file")" != "index.html" ]]; then
        filename="$(basename -- "$source_file")"
        if [[ "$filename" == "canvaskit.wasm" ]]; then
            echo "==> OSS 内部复制 $filename"
            aliyun ossutil cp \
                "oss://$OSS_BUCKET/web/releases/$RELEASE_REVISION/$filename" \
                "oss://$OSS_BUCKET/$filename" --force --copy-props none \
                --cache-control "$REVALIDATE_CACHE_CONTROL" \
                --content-type application/wasm \
                --endpoint "$OSS_UPLOAD_ENDPOINT" --addressing-style "$OSS_ADDRESSING_STYLE"
            # ossutil cp can omit Cache-Control on an OSS-to-OSS copy even when
            # passed above. Update the destination's properties explicitly.
            aliyun ossutil set-props "oss://$OSS_BUCKET/$filename" \
                --cache-control "$REVALIDATE_CACHE_CONTROL" \
                --content-type application/wasm --metadata-directive update --force \
                --endpoint "$OSS_UPLOAD_ENDPOINT" --addressing-style "$OSS_ADDRESSING_STYLE"
        else
            upload_file "$source_file" "oss://$OSS_BUCKET/$filename" "$REVALIDATE_CACHE_CONTROL"
        fi
    fi
done

echo "==> OSS immutable release 已上传，等待公开 HTTP 预激活验证：$RELEASE_REVISION"
