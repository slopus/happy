#!/usr/bin/env bash
# Independent DreamSkin test site. Production :8443 is never a deployment target.
set -euo pipefail

readonly STAGING_ORIGIN='https://47.115.228.20:8444'
readonly STAGING_ROOT='/var/www/paws-web-staging'
readonly CADDY_FILE='/etc/caddy/Caddyfile'
readonly mode="${1:---deploy}"
readonly target="${2:-}"
readonly repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

remote() {
    local command="$1"
    # The outer SSH lands on MacBook Air; its shell must pass one command to aliyun.
    ssh macbook-air "ssh aliyun $(printf '%q' "$command")"
}

require_revision() {
    [[ "$1" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected a 40-character lowercase Git SHA.' >&2; exit 2; }
}

verify_live() {
    local checked_revision="$1"
    local level="${2:-full}"
    local marker
    local html
    local party_html
    marker="$(curl --fail --silent --show-error --insecure "$STAGING_ORIGIN/.paws-release-revision")" || return 1
    [[ "$marker" == "$checked_revision" ]] || { echo "Staging revision mismatch: expected $checked_revision, got $marker" >&2; return 1; }
    curl --fail --silent --show-error --insecure "$STAGING_ORIGIN/health" | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{let j=JSON.parse(s);if(j.status!=="ok"||j.service!=="happy-server")process.exit(1)})' || return 1
    html="$(curl --fail --silent --show-error --insecure "$STAGING_ORIGIN/restore")" || return 1
    [[ "$html" == *"name=\"paws-release-revision\" content=\"$checked_revision\""* ]] || { echo 'Staging HTML revision mismatch' >&2; return 1; }
    if [[ "$level" == basic ]]; then
        echo "Verified basic $STAGING_ORIGIN at $checked_revision"
        return
    fi
    local skin_file skin_url skin_cache skin_hash remote_skin_hash
    skin_file="$(find "$repo_root/packages/happy-app/dist/desktop-skins/dreamskin" -maxdepth 1 -type f -name 'background.*.webp' -print -quit)"
    [[ -n "$skin_file" ]] || { echo 'Optimized DreamSkin background missing from build' >&2; return 1; }
    skin_url="/desktop-skins/dreamskin/${skin_file##*/}"
    [[ "$html" == *"$skin_url"* ]] || { echo 'DreamSkin preload missing from staging HTML' >&2; return 1; }
    skin_cache="$(curl --fail --silent --show-error --insecure --head "$STAGING_ORIGIN$skin_url" | tr -d '\r' | awk 'tolower($1) == "cache-control:" { print $2, $3, $4 }')" || return 1
    [[ "$skin_cache" == *max-age=31536000* && "$skin_cache" == *immutable* && "$skin_cache" != *no-store* ]] || { echo "DreamSkin cache policy is not immutable: $skin_cache" >&2; return 1; }
    skin_hash="$(shasum -a 256 "$skin_file" | cut -d ' ' -f 1)"
    remote_skin_hash="$(curl --fail --silent --show-error --insecure "$STAGING_ORIGIN$skin_url" | shasum -a 256 | cut -d ' ' -f 1)" || return 1
    [[ "$skin_hash" == "$remote_skin_hash" ]] || { echo 'DreamSkin background hash mismatch' >&2; return 1; }
    party_html="$(curl --fail --silent --show-error --insecure "$STAGING_ORIGIN/agent-party/")" || return 1
    [[ "$party_html" == *'/agent-party/assets/'* ]] || { echo 'AgentParty static UI missing' >&2; return 1; }
    [[ "$(curl --fail --silent --show-error --insecure "$STAGING_ORIGIN/agent-party/api/access/config")" == '{"accountMode":true}' ]] || { echo 'AgentParty gateway unavailable' >&2; return 1; }
    [[ "$(curl --silent --insecure --output /dev/null --write-out '%{http_code}' --request POST --header 'Origin: https://evil.invalid' "$STAGING_ORIGIN/agent-party/api/access/ticket")" == 403 ]] || { echo 'Foreign Origin was not rejected' >&2; return 1; }
    [[ "$(curl --silent --insecure --output /dev/null --write-out '%{http_code}' --request POST "$STAGING_ORIGIN/agent-party/api/access/ticket")" == 403 ]] || { echo 'Missing Origin was not rejected' >&2; return 1; }
    [[ "$(curl --silent --insecure --output /dev/null --write-out '%{http_code}' "$STAGING_ORIGIN/_expo/missing.js")" == 404 ]] || { echo 'Missing static asset did not return 404' >&2; return 1; }
    echo "Verified $STAGING_ORIGIN at $checked_revision"
}

prepare_current_release() {
    local existing_revision="$1"
    require_revision "$existing_revision"
    remote "bash -s -- '$existing_revision'" <<'REMOTE_PREPARE'
set -euo pipefail
revision="$1"; root='/var/www/paws-web-staging'
exec 9> "$root/.deploy.lock"; flock -x 9
[[ "$(cat "$root/current/.paws-release-revision")" == "$revision" ]]
release="$root/releases/$revision"
[[ -s "$release/index.html" ]]
if [[ ! -e "$release/.paws-staging-checksums.sha256" ]]; then
    manifest="$(mktemp "$root/.manifest.$revision.XXXXXXXX")"
    trap 'rm -f "$manifest"' EXIT
    (cd "$release" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) > "$manifest"
    mv "$manifest" "$release/.paws-staging-checksums.sha256"
    trap - EXIT
fi
(cd "$release" && sha256sum -c .paws-staging-checksums.sha256 >/dev/null)
REMOTE_PREPARE
}

install_caddy() {
    local before_sha="$1" after_sha="$2" expected_revision="$3" candidate="$4" backup="$5"
    remote "bash -s -- '$before_sha' '$after_sha' '$expected_revision' '$candidate' '$backup'" <<'REMOTE_CADDY'
set -euo pipefail
original_sha="$1"; candidate_sha="$2"; expected="$3"; candidate="$4"; backup="$5"
root='/var/www/paws-web-staging'; caddy_file='/etc/caddy/Caddyfile'
exec 9> "$root/.deploy.lock"; flock -x 9
[[ "$(cat "$root/current/.paws-release-revision")" == "$expected" ]]
[[ "$(sha256sum "$caddy_file" | cut -d ' ' -f 1)" == "$original_sha" ]] || { echo 'Caddy changed concurrently' >&2; exit 1; }
[[ "$(sha256sum "$candidate" | cut -d ' ' -f 1)" == "$candidate_sha" ]]
caddy validate --config "$candidate"
cp "$caddy_file" "$backup"
install -m 0644 "$candidate" "$caddy_file"
if ! caddy reload --config "$caddy_file"; then
    install -m 0644 "$backup" "$caddy_file"
    caddy reload --config "$caddy_file"
    exit 1
fi
REMOTE_CADDY
}

restore_caddy() {
    [[ "${caddy_changed:-0}" == 1 ]] || return 0
    remote "bash -s -- '$candidate_sha' '$original_sha' '$old_revision' '$backup_path' '$candidate_path'" <<'REMOTE_CADDY_RESTORE'
set -euo pipefail
candidate_sha="$1"; original_sha="$2"; expected="$3"; backup="$4"; candidate="$5"
root='/var/www/paws-web-staging'; caddy_file='/etc/caddy/Caddyfile'
exec 9> "$root/.deploy.lock"; flock -x 9
[[ "$(cat "$root/current/.paws-release-revision")" == "$expected" ]]
[[ "$(sha256sum "$caddy_file" | cut -d ' ' -f 1)" == "$candidate_sha" ]] || { echo 'Caddy changed concurrently; refusing to overwrite' >&2; exit 1; }
[[ "$(sha256sum "$backup" | cut -d ' ' -f 1)" == "$original_sha" ]]
caddy validate --config "$backup"
install -m 0644 "$backup" "$caddy_file"
if ! caddy reload --config "$caddy_file"; then
    install -m 0644 "$candidate" "$caddy_file"
    caddy reload --config "$caddy_file"
    exit 1
fi
REMOTE_CADDY_RESTORE
}

activate() {
    local next_revision="$1"
    local expected_current="$2"
    require_revision "$next_revision"
    require_revision "$expected_current"
    remote "bash -s -- '$next_revision' '$expected_current'" <<'REMOTE_ACTIVATE'
set -euo pipefail
revision="$1"; expected="$2"; root='/var/www/paws-web-staging'
exec 9> "$root/.deploy.lock"
flock -x 9
current="$(cat "$root/current/.paws-release-revision")"
[[ "$current" == "$expected" ]] || { echo "Staging changed concurrently: expected $expected, got $current" >&2; exit 1; }
release="$root/releases/$revision"
[[ "$(cat "$release/.paws-release-revision")" == "$revision" && -s "$release/index.html" ]]
(cd "$release" && sha256sum -c .paws-staging-checksums.sha256 >/dev/null)
ln -sfn "$root/releases/$revision" "$root/current.next"
mv -Tf "$root/current.next" "$root/current"
ln -sfn "$root/releases/$current" "$root/previous.next"
mv -Tf "$root/previous.next" "$root/previous"
REMOTE_ACTIVATE
}

if [[ "$mode" == '--rollback' ]]; then
    require_revision "$target"
    readonly current_revision="$(remote "cat '$STAGING_ROOT/current/.paws-release-revision'" | tr -d '[:space:]')"
    require_revision "$current_revision"
    activate "$target" "$current_revision"
    verify_live "$target" basic
    exit
fi
[[ "$mode" == '--deploy' && -z "$target" ]] || { echo 'Usage: bash scripts/deploy-staging-web.sh [--deploy | --rollback <revision>]' >&2; exit 2; }

[[ -z "$(git status --porcelain)" ]] || { echo 'Commit all staging changes before deployment.' >&2; exit 1; }
readonly revision="$(git rev-parse HEAD)"
require_revision "$revision"
[[ "$(git branch --show-current)" != main ]] || { echo 'Staging must deploy from a feature worktree.' >&2; exit 1; }

readonly temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/paws-staging-deploy.XXXXXX")"
trap 'rm -rf "$temp_dir"' EXIT

CI=1 APP_ENV=production EXPO_PUBLIC_HAPPY_SERVER_URL="$STAGING_ORIGIN" EXPO_PUBLIC_DREAMSKIN_STAGING_DEFAULT=1 \
    HAPPY_BUILD_COMMIT_SHA="$revision" HAPPY_BUILD_COMMIT_TIMESTAMP="$(git show -s --format=%cI HEAD)" \
    pnpm --filter happy-app export:web
node scripts/inject-staging-dreamskin-preload.mjs packages/happy-app/dist/index.html
node scripts/inject-web-runtime-server-config.mjs packages/happy-app/dist/index.html
node scripts/stamp-web-release.mjs packages/happy-app/dist/index.html packages/happy-app/dist/.paws-release-revision "$revision"
PAWS_AGENT_PARTY_BASE_PATH=/agent-party/ pnpm --filter @wangjs-jacky/paws-agent-party exec vite build --config vite.config.ts
mkdir -p packages/happy-app/dist/agent-party
cp -R packages/paws-agent-party/dist/web/. packages/happy-app/dist/agent-party/
node scripts/write-staging-web-checksums.mjs packages/happy-app/dist
readonly manifest_sha="$(shasum -a 256 packages/happy-app/dist/.paws-staging-checksums.sha256 | cut -d ' ' -f 1)"
tar -C packages/happy-app/dist -czf "$temp_dir/release.tgz" .

remote "set -e; mkdir -p '$STAGING_ROOT/releases'; exec 9> '$STAGING_ROOT/.deploy.lock'; flock -x 9; release='$STAGING_ROOT/releases/$revision'; if [ -d \"\$release\" ]; then cat >/dev/null; else temp=\$(mktemp -d '$STAGING_ROOT/releases/.${revision}.XXXXXXXX'); trap 'rm -rf \"\$temp\"' EXIT; tar -xz -C \"\$temp\"; test \"\$(cat \"\$temp/.paws-release-revision\")\" = '$revision'; test \"\$(sha256sum \"\$temp/.paws-staging-checksums.sha256\" | cut -d ' ' -f 1)\" = '$manifest_sha'; (cd \"\$temp\" && sha256sum -c .paws-staging-checksums.sha256 >/dev/null); mv \"\$temp\" \"\$release\"; trap - EXIT; fi; test \"\$(sha256sum \"\$release/.paws-staging-checksums.sha256\" | cut -d ' ' -f 1)\" = '$manifest_sha'; (cd \"\$release\" && sha256sum -c .paws-staging-checksums.sha256 >/dev/null)" < "$temp_dir/release.tgz"

readonly old_revision="$(remote "cat '$STAGING_ROOT/current/.paws-release-revision'" | tr -d '[:space:]')"
require_revision "$old_revision"
prepare_current_release "$old_revision"

remote "cat '$CADDY_FILE'" > "$temp_dir/Caddyfile.before"
node scripts/configure-staging-web-caddy.mjs "$temp_dir/Caddyfile.before" "$temp_dir/Caddyfile.next"
caddy_changed=0
if ! cmp -s "$temp_dir/Caddyfile.before" "$temp_dir/Caddyfile.next"; then
    readonly original_sha="$(shasum -a 256 "$temp_dir/Caddyfile.before" | cut -d ' ' -f 1)"
    readonly candidate_sha="$(shasum -a 256 "$temp_dir/Caddyfile.next" | cut -d ' ' -f 1)"
    readonly candidate_path="$STAGING_ROOT/Caddyfile.$revision.$$.next"
    readonly backup_path="$STAGING_ROOT/Caddyfile.$revision.$$.before"
    remote "cat > '$candidate_path'" < "$temp_dir/Caddyfile.next"
    install_caddy "$original_sha" "$candidate_sha" "$old_revision" "$candidate_path" "$backup_path"
    caddy_changed=1
fi

if ! activate "$revision" "$old_revision"; then
    echo 'Staging activation failed; checking whether the old release needs restoration' >&2
    observed_revision="$(remote "cat '$STAGING_ROOT/current/.paws-release-revision'" | tr -d '[:space:]')"
    if [[ "$observed_revision" == "$revision" ]]; then activate "$old_revision" "$revision"; fi
    restore_caddy
    exit 1
fi
if ! verify_live "$revision"; then
    echo "Staging validation failed; restoring $old_revision" >&2
    activate "$old_revision" "$revision"
    restore_caddy
    verify_live "$old_revision" basic
    exit 1
fi
remote "bash -s -- '$STAGING_ROOT' '$revision' '$old_revision'" < "$repo_root/scripts/prune-staging-web-releases.sh"
echo "Rollback: bash scripts/deploy-staging-web.sh --rollback $old_revision"
