#!/usr/bin/env bash

set -euo pipefail

readonly CANONICAL_WEB_ORIGIN="https://47.115.228.20:8443"
readonly OSS_BUCKET="${PAWS_WEB_OSS_BUCKET:-happy-app-ota-jacky}"
readonly OSS_UPLOAD_ENDPOINT="${OSS_UPLOAD_ENDPOINT:-https://oss-cn-hangzhou.aliyuncs.com}"
readonly OSS_ADDRESSING_STYLE="${OSS_ADDRESSING_STYLE:-virtual}"
readonly OSS_PUBLIC_ORIGIN="${PAWS_WEB_OSS_ORIGIN:-https://$OSS_BUCKET.oss-cn-hangzhou.aliyuncs.com}"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
readonly DIST_DIR="${PAWS_WEB_DIST_DIR:-$REPO_ROOT/packages/happy-app/dist}"
readonly RELEASE_MARKER="$DIST_DIR/.paws-release-revision"

show_usage() {
    cat <<'USAGE'
Build Paws Web and atomically switch the stable OSS entry.

Required environment:
  PAWS_WEB_ORIGIN       Must be https://47.115.228.20:8443

Optional environment:
  PAWS_WEB_OSS_BUCKET   OSS bucket, default happy-app-ota-jacky
  PAWS_SKIP_BUILD       Set to 1 to reuse a stamped dist from this origin/main
  PAWS_WEB_DIST_DIR     Override dist location
  PAWS_WEB_RELEASE_ID   Safe rollback identifier

Normal releases require a clean main exactly aligned with origin/main.
Rollback mode:
  bash scripts/deploy-web.sh --rollback web/rollback/<release-id>
USAGE
}

fail() {
    echo "错误：$*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || fail "找不到命令 $1。"
}

oss_args=(--endpoint "$OSS_UPLOAD_ENDPOINT" --addressing-style "$OSS_ADDRESSING_STYLE")

oss_http_exists() {
    local object_path="$1"
    local status
    status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
        --head "$OSS_PUBLIC_ORIGIN/$object_path")" \
        || fail "无法通过公开 HTTP 检查 OSS object：$object_path"
    case "$status" in
        200) return 0 ;;
        404) return 1 ;;
        *) fail "公开 HTTP 检查 OSS object $object_path 返回 $status。" ;;
    esac
}

oss_copy_preserving() {
    aliyun ossutil cp "$1" "$2" --force "${oss_args[@]}"
}

oss_copy_current_marker() {
    aliyun ossutil cp "$1" "$2" --force --copy-props none \
        --cache-control no-cache --content-type text/plain \
        "${oss_args[@]}"
}

oss_copy_current_html() {
    aliyun ossutil cp "$1" "$2" --force --copy-props none \
        --cache-control no-cache --content-type "text/html; charset=utf-8" \
        "${oss_args[@]}"
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    show_usage
    exit 0
fi

if [[ -z "${PAWS_WEB_ORIGIN:-}" ]]; then
    show_usage >&2
    fail "缺少环境变量 PAWS_WEB_ORIGIN。"
fi
if [[ "$PAWS_WEB_ORIGIN" != "$CANONICAL_WEB_ORIGIN" ]]; then
    fail "Paws Web 只能发布到 $CANONICAL_WEB_ORIGIN。"
fi
if [[ ! "$OSS_BUCKET" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]]; then
    fail "PAWS_WEB_OSS_BUCKET 不是合法的 OSS Bucket 名称。"
fi

require_command aliyun
require_command curl
aliyun ossutil --help >/dev/null 2>&1 || fail "需要带 ossutil 子命令的 aliyun CLI。"

if [[ "${1:-}" == "--rollback" ]]; then
    rollback_prefix="${2:-}"
    if [[ ! "$rollback_prefix" =~ ^web/rollback/[A-Za-z0-9._-]+$ ]]; then
        fail "rollback prefix 必须匹配 web/rollback/<safe-release-id>。"
    fi
    rollback_marker="oss://$OSS_BUCKET/$rollback_prefix/.paws-release-revision"
    rollback_index="oss://$OSS_BUCKET/$rollback_prefix/index.html"
    current_marker="oss://$OSS_BUCKET/web/current/.paws-release-revision"
    current_index="oss://$OSS_BUCKET/web/current/index.html"
    oss_http_exists "$rollback_prefix/.paws-release-revision" || fail "rollback marker 不存在：$rollback_marker"
    oss_http_exists "$rollback_prefix/index.html" || fail "rollback index 不存在：$rollback_index"
    echo "==> 恢复 OSS Web marker：$rollback_prefix"
    oss_copy_current_marker "$rollback_marker" "$current_marker"
    echo "==> 最后切换 OSS Web HTML：$rollback_prefix"
    oss_copy_current_html "$rollback_index" "$current_index"
    echo "==> OSS Web rollback 完成：$rollback_prefix"
    exit 0
fi
if [[ $# -gt 0 ]]; then
    show_usage >&2
    fail "未知参数：$*"
fi

require_command git
require_command pnpm

assert_main_release_source() {
    echo "==> 校验发布来源 origin/main"
    git -C "$REPO_ROOT" fetch --quiet origin main
    local current_branch
    local current_revision
    local origin_main_revision
    current_branch="$(git -C "$REPO_ROOT" branch --show-current)"
    [[ "$current_branch" == "main" ]] || fail "Web 只允许从 main 分支发布，当前为 ${current_branch:-detached HEAD}。"
    [[ -z "$(git -C "$REPO_ROOT" status --short)" ]] || fail "Web 发布要求干净工作区。"
    current_revision="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    origin_main_revision="$(git -C "$REPO_ROOT" rev-parse refs/remotes/origin/main)"
    [[ "$current_revision" == "$origin_main_revision" ]] || fail "当前 main 与 origin/main 不一致。"
    RELEASE_REVISION="$current_revision"
    RELEASE_TIMESTAMP="$(git -C "$REPO_ROOT" show -s --format=%cI "$RELEASE_REVISION")"
    echo "==> 锁定发布提交 ${RELEASE_REVISION:0:12}"
}

assert_release_source_unchanged() {
    git -C "$REPO_ROOT" fetch --quiet origin main
    local current_revision
    local origin_main_revision
    current_revision="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    origin_main_revision="$(git -C "$REPO_ROOT" rev-parse refs/remotes/origin/main)"
    [[ "$current_revision" == "$RELEASE_REVISION" && "$origin_main_revision" == "$RELEASE_REVISION" ]] \
        || fail "发布期间 main 已变化。"
    [[ -z "$(git -C "$REPO_ROOT" status --short)" ]] || fail "构建期间工作区发生变化。"
}

assert_main_release_source

if [[ "${PAWS_SKIP_BUILD:-0}" != "1" ]]; then
    echo "==> 构建 Paws Web App"
    (
        cd "$REPO_ROOT"
        CI=1 APP_ENV=production EXPO_PUBLIC_HAPPY_SERVER_URL="$PAWS_WEB_ORIGIN" \
            HAPPY_BUILD_COMMIT_SHA="$RELEASE_REVISION" \
            HAPPY_BUILD_COMMIT_TIMESTAMP="$RELEASE_TIMESTAMP" \
            pnpm --filter happy-app export:web
    )
    node "$SCRIPT_DIR/stamp-web-release.mjs" "$DIST_DIR/index.html" "$RELEASE_MARKER" "$RELEASE_REVISION"
else
    echo "==> 跳过构建，复用已盖章 Web 产物"
fi

assert_release_source_unchanged
[[ -f "$DIST_DIR/index.html" ]] || fail "未找到 $DIST_DIR/index.html。"
[[ -f "$RELEASE_MARKER" ]] || fail "未找到 $RELEASE_MARKER。"
artifact_revision="$(tr -d '[:space:]' < "$RELEASE_MARKER")"
[[ "$artifact_revision" == "$RELEASE_REVISION" ]] || fail "dist revision $artifact_revision 与 origin/main $RELEASE_REVISION 不一致。"
grep -Fq "<meta name=\"paws-release-revision\" content=\"$RELEASE_REVISION\">" "$DIST_DIR/index.html" \
    || fail "index.html 缺少匹配的 release revision meta。"

release_prefix="web/releases/$RELEASE_REVISION"
release_marker="oss://$OSS_BUCKET/$release_prefix/.paws-release-revision"
release_index="oss://$OSS_BUCKET/$release_prefix/index.html"
current_marker="oss://$OSS_BUCKET/web/current/.paws-release-revision"
current_index="oss://$OSS_BUCKET/web/current/index.html"
oss_http_exists "$release_prefix/.paws-release-revision" || fail "immutable release marker 未上传：$release_marker"
oss_http_exists "$release_prefix/index.html" || fail "immutable release index 未上传：$release_index"

release_id="${PAWS_WEB_RELEASE_ID:-${GITHUB_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}-${RELEASE_REVISION:0:12}}"
[[ "$release_id" =~ ^[A-Za-z0-9._-]+$ ]] || fail "PAWS_WEB_RELEASE_ID 含不安全字符。"
rollback_prefix="web/rollback/$release_id"
rollback_marker="oss://$OSS_BUCKET/$rollback_prefix/.paws-release-revision"
rollback_index="oss://$OSS_BUCKET/$rollback_prefix/index.html"

has_current_marker=0
has_current_index=0
oss_http_exists "web/current/.paws-release-revision" && has_current_marker=1
oss_http_exists "web/current/index.html" && has_current_index=1
if [[ "$has_current_marker" != "$has_current_index" ]]; then
    fail "OSS current marker/index 状态不一致，拒绝切换。"
fi
if [[ "$has_current_marker" == "1" ]]; then
    echo "==> 备份当前 OSS Web entry：$rollback_prefix"
    oss_copy_preserving "$current_marker" "$rollback_marker"
    oss_copy_preserving "$current_index" "$rollback_index"
fi

echo "==> 暂存 OSS Web marker：${RELEASE_REVISION:0:12}"
oss_copy_current_marker "$release_marker" "$current_marker"
echo "==> 最后切换 OSS Web HTML：${RELEASE_REVISION:0:12}"
if ! oss_copy_current_html "$release_index" "$current_index"; then
    echo "错误：OSS Web HTML 切换失败，正在恢复 marker。" >&2
    if [[ "$has_current_marker" == "1" ]]; then
        oss_copy_current_marker "$rollback_marker" "$current_marker" \
            || echo "错误：上一版 marker 自动恢复失败。" >&2
    else
        aliyun ossutil rm "$current_marker" --force "${oss_args[@]}" \
            || echo "错误：首次发布 marker 清理失败。" >&2
    fi
    exit 1
fi

if [[ "$has_current_marker" == "1" && -n "${GITHUB_OUTPUT:-}" ]]; then
    printf 'rollback_prefix=%s\n' "$rollback_prefix" >> "$GITHUB_OUTPUT"
fi

echo "==> OSS Web entry 已切换：$RELEASE_REVISION"
