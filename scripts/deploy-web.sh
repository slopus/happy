#!/usr/bin/env bash

set -euo pipefail

show_usage() {
    cat <<'USAGE'
构建 Paws Web App，并以原子切换方式部署到 SSH 服务器。

必填环境变量：
  PAWS_WEB_ORIGIN    浏览器最终访问的服务地址，例如 https://paws.example.com
  PAWS_DEPLOY_HOST   SSH 目标，例如 deploy@paws.example.com
  PAWS_DEPLOY_PATH   服务器上的绝对发布目录，例如 /var/www/paws-web/current

可选环境变量：
  PAWS_DEPLOY_PORT   SSH 端口，默认 22
  PAWS_SKIP_BUILD    设为 1 时复用由本脚本生成且与 origin/main 一致的 dist

发布保护：
  只允许从干净、与 origin/main 完全一致的 main 分支发布。
  构建期间如果 main 被推进或工作区发生变化，发布会中止。

示例：
  PAWS_WEB_ORIGIN=https://paws.example.com \
  PAWS_DEPLOY_HOST=deploy@paws.example.com \
  PAWS_DEPLOY_PATH=/var/www/paws-web/current \
  pnpm web:deploy
USAGE
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    show_usage
    exit 0
fi

require_env() {
    local variable_name="$1"
    if [[ -z "${!variable_name:-}" ]]; then
        echo "错误：缺少环境变量 ${variable_name}。" >&2
        show_usage >&2
        exit 2
    fi
}

require_command() {
    local command_name="$1"
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "错误：找不到命令 ${command_name}。" >&2
        exit 2
    fi
}

validate_deploy_path() {
    local deploy_path="$1"

    if [[ "$deploy_path" != /* ]]; then
        echo "错误：PAWS_DEPLOY_PATH 必须是服务器上的绝对路径。" >&2
        exit 2
    fi

    case "$deploy_path" in
        /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/root|/run|/sbin|/srv|/tmp|/usr|/var|/var/www)
            echo "错误：PAWS_DEPLOY_PATH 范围过大，请指定专用子目录。" >&2
            exit 2
            ;;
        *"/../"*|*"/.."|*"/./"*|*"/."|*"//"*)
            echo "错误：PAWS_DEPLOY_PATH 不能包含相对路径段或重复斜杠。" >&2
            exit 2
            ;;
    esac
}

calculate_sha256() {
    local file_path="$1"

    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$file_path" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$file_path" | awk '{print $1}'
    else
        echo "错误：找不到 sha256sum 或 shasum。" >&2
        exit 2
    fi
}

require_env PAWS_WEB_ORIGIN
require_env PAWS_DEPLOY_HOST
require_env PAWS_DEPLOY_PATH

CANONICAL_WEB_ORIGIN="https://47.115.228.20:8443"
if [[ "$PAWS_WEB_ORIGIN" != "$CANONICAL_WEB_ORIGIN" ]]; then
    echo "错误：Paws Web 只能发布到 ${CANONICAL_WEB_ORIGIN}。" >&2
    exit 2
fi

if [[ ! "$PAWS_WEB_ORIGIN" =~ ^https?://[^[:space:]]+$ ]]; then
    echo "错误：PAWS_WEB_ORIGIN 必须是完整的 http:// 或 https:// 地址。" >&2
    exit 2
fi

PAWS_DEPLOY_PORT="${PAWS_DEPLOY_PORT:-22}"
if [[ ! "$PAWS_DEPLOY_PORT" =~ ^[0-9]+$ ]] ||
    ((PAWS_DEPLOY_PORT < 1 || PAWS_DEPLOY_PORT > 65535)); then
    echo "错误：PAWS_DEPLOY_PORT 必须是 1 到 65535 之间的数字。" >&2
    exit 2
fi

validate_deploy_path "$PAWS_DEPLOY_PATH"

require_command pnpm
require_command git
require_command ssh
require_command scp
require_command tar

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$REPO_ROOT/packages/happy-app/dist"
RELEASE_MARKER="$DIST_DIR/.paws-release-revision"

assert_main_release_source() {
    local current_branch
    local current_revision
    local origin_main_revision

    echo "==> 校验发布来源 origin/main"
    git -C "$REPO_ROOT" fetch --quiet origin main

    current_branch="$(git -C "$REPO_ROOT" branch --show-current)"
    if [[ "$current_branch" != "main" ]]; then
        echo "错误：Web 只允许从 main 分支发布，当前为 ${current_branch:-detached HEAD}。" >&2
        exit 1
    fi

    if [[ -n "$(git -C "$REPO_ROOT" status --short)" ]]; then
        echo "错误：Web 发布要求干净工作区。" >&2
        exit 1
    fi

    current_revision="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    origin_main_revision="$(git -C "$REPO_ROOT" rev-parse refs/remotes/origin/main)"
    if [[ "$current_revision" != "$origin_main_revision" ]]; then
        echo "错误：当前 main 与 origin/main 不一致，请更新后重试。" >&2
        echo "  HEAD:        $current_revision" >&2
        echo "  origin/main: $origin_main_revision" >&2
        exit 1
    fi

    RELEASE_REVISION="$current_revision"
    RELEASE_TIMESTAMP="$(git -C "$REPO_ROOT" show -s --format=%cI "$RELEASE_REVISION")"
    echo "==> 锁定发布提交 ${RELEASE_REVISION:0:12}"
}

assert_release_source_unchanged() {
    local current_revision
    local origin_main_revision

    git -C "$REPO_ROOT" fetch --quiet origin main
    current_revision="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    origin_main_revision="$(git -C "$REPO_ROOT" rev-parse refs/remotes/origin/main)"
    if [[ "$current_revision" != "$RELEASE_REVISION" || "$origin_main_revision" != "$RELEASE_REVISION" ]]; then
        echo "错误：发布期间 main 已变化，为避免发布错配产物已中止。" >&2
        echo "  锁定提交:   $RELEASE_REVISION" >&2
        echo "  当前 HEAD:   $current_revision" >&2
        echo "  origin/main: $origin_main_revision" >&2
        exit 1
    fi

    if [[ -n "$(git -C "$REPO_ROOT" status --short)" ]]; then
        echo "错误：构建期间工作区发生变化，发布已中止。" >&2
        exit 1
    fi
}

assert_main_release_source

if [[ "${PAWS_SKIP_BUILD:-0}" != "1" ]]; then
    echo "==> 构建 Paws Web App"
    (
        cd "$REPO_ROOT"
        CI=1 \
            APP_ENV=production \
            EXPO_PUBLIC_HAPPY_SERVER_URL="$PAWS_WEB_ORIGIN" \
            HAPPY_BUILD_COMMIT_SHA="$RELEASE_REVISION" \
            HAPPY_BUILD_COMMIT_TIMESTAMP="$RELEASE_TIMESTAMP" \
            pnpm --filter happy-app export:web
    )
    printf '%s\n' "$RELEASE_REVISION" > "$RELEASE_MARKER"
else
    echo "==> 跳过构建，复用现有 Web 产物"
    if [[ ! -f "$RELEASE_MARKER" ]]; then
        echo "错误：缺少 $RELEASE_MARKER，不能确认 dist 来自 origin/main。" >&2
        echo "请取消 PAWS_SKIP_BUILD 并由本脚本重新构建。" >&2
        exit 1
    fi
    artifact_revision="$(tr -d '[:space:]' < "$RELEASE_MARKER")"
    if [[ "$artifact_revision" != "$RELEASE_REVISION" ]]; then
        echo "错误：现有 dist 来自 $artifact_revision，当前 origin/main 为 $RELEASE_REVISION。" >&2
        exit 1
    fi
fi

assert_release_source_unchanged

if [[ ! -f "$DIST_DIR/index.html" ]]; then
    echo "错误：未找到 $DIST_DIR/index.html，请先完成 Web 构建。" >&2
    exit 1
fi

RELEASE_TIME="$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE_ID="${RELEASE_TIME}-${RELEASE_REVISION:0:12}"
TEMP_BASE="${TMPDIR:-/tmp}"
TEMP_BASE="${TEMP_BASE%/}"
TEMP_DIR="$(mktemp -d "${TEMP_BASE}/paws-web-deploy.XXXXXX")"
ARCHIVE_NAME="paws-web-${RELEASE_ID}.tar.gz"
ARCHIVE_PATH="$TEMP_DIR/$ARCHIVE_NAME"

cleanup_local() {
    case "$TEMP_DIR" in
        "${TEMP_BASE}"/paws-web-deploy.*)
            rm -rf -- "$TEMP_DIR"
            ;;
    esac
}
trap cleanup_local EXIT

echo "==> 打包并计算校验值"
tar -C "$DIST_DIR" -czf "$ARCHIVE_PATH" .
ARCHIVE_SHA256="$(calculate_sha256 "$ARCHIVE_PATH")"

echo "==> 上传到 ${PAWS_DEPLOY_HOST}"
scp -P "$PAWS_DEPLOY_PORT" "$ARCHIVE_PATH" \
    "${PAWS_DEPLOY_HOST}:/tmp/${ARCHIVE_NAME}"

assert_release_source_unchanged

echo "==> 在服务器上切换发布目录"
ssh -p "$PAWS_DEPLOY_PORT" "$PAWS_DEPLOY_HOST" bash -s -- \
    "$ARCHIVE_NAME" \
    "$ARCHIVE_SHA256" \
    "$PAWS_DEPLOY_PATH" \
    "$RELEASE_ID" <<'REMOTE_SCRIPT'
set -euo pipefail

archive_name="$1"
expected_sha256="$2"
deploy_path="$3"
release_id="$4"

case "$archive_name" in
    paws-web-*.tar.gz) ;;
    *)
        echo "错误：上传包名称不合法。" >&2
        exit 2
        ;;
esac

if [[ "$deploy_path" != /* ]]; then
    echo "错误：远端部署目录必须是绝对路径。" >&2
    exit 2
fi

case "$deploy_path" in
    /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/root|/run|/sbin|/srv|/tmp|/usr|/var|/var/www)
        echo "错误：远端部署目录范围过大。" >&2
        exit 2
        ;;
    *"/../"*|*"/.."|*"/./"*|*"/."|*"//"*)
        echo "错误：远端部署目录不能包含相对路径段或重复斜杠。" >&2
        exit 2
        ;;
esac

archive_path="/tmp/$archive_name"
stage_path="${deploy_path}.next-${release_id}"
backup_path="${deploy_path}.backup-${release_id}"

cleanup_remote() {
    rm -f -- "$archive_path"
    if [[ -d "$stage_path" ]]; then
        rm -rf -- "$stage_path"
    fi
}
trap cleanup_remote EXIT

if command -v sha256sum >/dev/null 2>&1; then
    actual_sha256="$(sha256sum "$archive_path" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
    actual_sha256="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
else
    echo "错误：服务器缺少 sha256sum 或 shasum。" >&2
    exit 2
fi

if [[ "$actual_sha256" != "$expected_sha256" ]]; then
    echo "错误：上传包 SHA-256 校验失败。" >&2
    exit 1
fi

mkdir -p -- "$(dirname -- "$deploy_path")"

if [[ -e "$stage_path" || -e "$backup_path" ]]; then
    echo "错误：同名发布目录已存在，请稍后重试。" >&2
    exit 1
fi

mkdir -- "$stage_path"
tar -xzf "$archive_path" -C "$stage_path"

if [[ ! -f "$stage_path/index.html" ]]; then
    echo "错误：发布包中缺少 index.html。" >&2
    exit 1
fi

if [[ -e "$deploy_path" ]]; then
    mv -- "$deploy_path" "$backup_path"
fi

if ! mv -- "$stage_path" "$deploy_path"; then
    if [[ -e "$backup_path" && ! -e "$deploy_path" ]]; then
        mv -- "$backup_path" "$deploy_path"
    fi
    echo "错误：切换发布目录失败，已尝试恢复上一版本。" >&2
    exit 1
fi

echo "发布完成：$deploy_path"
if [[ -d "$backup_path" ]]; then
    echo "上一版本备份：$backup_path"
fi
REMOTE_SCRIPT

echo "==> 部署完成：${PAWS_WEB_ORIGIN}"
