#!/usr/bin/env bash
set -euo pipefail

# This companion release runs only after the canonical Web release is verified.
# It owns one container, one persistent directory, and one marked Caddy route.
readonly ORIGIN='https://47.115.228.20:8443'
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
readonly DEPLOY_HOST="${PAWS_DEPLOY_HOST:-root@47.115.228.20}"
readonly DEPLOY_PORT="${PAWS_DEPLOY_PORT:-22}"
readonly RELEASE_SHA="${PAWS_RELEASE_SHA:-${GITHUB_SHA:-}}"
readonly RELEASE_REF="${PAWS_RELEASE_REF:-${GITHUB_REF:-}}"
fail() { echo "AgentParty deployment: $*" >&2; exit 1; }

[[ "${PAWS_WEB_ORIGIN:-}" == "$ORIGIN" ]] || fail 'Canonical Web origin required.'
[[ "$DEPLOY_HOST" == 'root@47.115.228.20' && "$DEPLOY_PORT" == '22' ]] || fail 'Unexpected deployment target.'
[[ "${PAWS_AGENT_PARTY_ACCESS_TOKEN:-}" =~ ^[A-Za-z0-9_-]{43,128}$ ]] || fail 'Missing or invalid PAWS_AGENT_PARTY_ACCESS_TOKEN secret.'
[[ "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ ]] || fail 'An exact CI commit SHA is required.'
[[ "$RELEASE_REF" == 'refs/heads/main' ]] || fail 'Only merged main may deploy.'
git -C "$REPO_ROOT" fetch --quiet origin main
[[ "$(git -C "$REPO_ROOT" branch --show-current)" == main ]] || fail 'Expected main branch.'
[[ -z "$(git -C "$REPO_ROOT" status --short)" ]] || fail 'Expected clean worktree.'
[[ "$(git -C "$REPO_ROOT" rev-parse HEAD)" == "$RELEASE_SHA" ]] || fail 'HEAD changed.'
source "$SCRIPT_DIR/web-release-source.sh"
assert_web_release_is_current "$REPO_ROOT" "$RELEASE_SHA" "$(git -C "$REPO_ROOT" rev-parse origin/main)"
[[ "$(tr -d '[:space:]' < "$REPO_ROOT/packages/paws-agent-party/dist/revision")" == "$RELEASE_SHA" ]] || fail 'Artifact revision mismatch.'
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]] || fail 'Expected CI run identifiers.'
release_id="$RELEASE_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
image="paws-agent-party:$RELEASE_SHA"
remote_dir="/tmp/paws-agent-party-$release_id"
stage="$(mktemp -d)"
cleanup() { rm -f -- "$stage/image.tar.gz" "$stage/runtime.env" "$stage/Caddyfile.current" "$stage/Caddyfile.next"; rmdir -- "$stage"; }
trap cleanup EXIT
umask 077
# Never enable shell tracing or put the token in command arguments or logs.
printf 'PAWS_AGENT_PARTY_ACCESS_TOKEN=%s\n' "$PAWS_AGENT_PARTY_ACCESS_TOKEN" > "$stage/runtime.env"
docker build --file "$REPO_ROOT/packages/paws-agent-party/Dockerfile.production" --tag "$image" "$REPO_ROOT/packages/paws-agent-party"
docker save "$image" | gzip > "$stage/image.tar.gz"
ssh -p "$DEPLOY_PORT" "$DEPLOY_HOST" 'cat /etc/caddy/Caddyfile' > "$stage/Caddyfile.current"
node "$SCRIPT_DIR/configure-production-agent-party-caddy.mjs" "$stage/Caddyfile.current" "$stage/Caddyfile.next"
caddy_sha="$(sha256sum "$stage/Caddyfile.current" | cut -d ' ' -f 1)"
image_sha="$(sha256sum "$stage/image.tar.gz" | cut -d ' ' -f 1)"
# Recheck after the image build, immediately before the first remote write.
git -C "$REPO_ROOT" fetch --quiet origin main
[[ "$(git -C "$REPO_ROOT" rev-parse HEAD)" == "$RELEASE_SHA" && -z "$(git -C "$REPO_ROOT" status --short)" ]] || fail 'Source changed during image build.'
assert_web_release_is_current "$REPO_ROOT" "$RELEASE_SHA" "$(git -C "$REPO_ROOT" rev-parse origin/main)"
ssh -p "$DEPLOY_PORT" "$DEPLOY_HOST" install -d -m 700 "$remote_dir"
scp -P "$DEPLOY_PORT" "$stage/image.tar.gz" "$stage/runtime.env" "$stage/Caddyfile.next" "$DEPLOY_HOST:$remote_dir/"
ssh -p "$DEPLOY_PORT" "$DEPLOY_HOST" bash -s -- "$release_id" "$RELEASE_SHA" "$caddy_sha" "$image_sha" <<'REMOTE_SCRIPT'
set -euo pipefail
release_id="$1"; revision="$2"; expected_caddy_sha="$3"; expected_image_sha="$4"
[[ "$release_id" =~ ^[a-f0-9]{40}-[0-9]+-[0-9]+$ && "$revision" =~ ^[a-f0-9]{40}$ ]]
stage="/tmp/paws-agent-party-$release_id"
image="paws-agent-party:$revision"
container='paws-agent-party-production'
previous="paws-agent-party-previous-$release_id"
data='/var/lib/paws-agent-party'
backup="/var/backups/paws-agent-party/$release_id"
config='/etc/caddy/Caddyfile'
old_present=0; renamed=0; new_created=0; data_backed_up=0; caddy_changed=0
wait_reload() {
  local reload_result
  for ((attempt=1; attempt<=30; attempt+=1)); do
    reload_result="$(systemctl show caddy --property=ReloadResult --value 2>/dev/null || true)"
    if [[ -z "$(systemctl list-jobs --no-legend --plain caddy.service)" && "$(systemctl show caddy --property=ActiveState --value)" == active ]] && { [[ -z "$reload_result" ]] || [[ "$reload_result" == success ]]; }; then return 0; fi
    sleep 1
  done
  return 1
}
cleanup() { rm -f -- "$stage/runtime.env" "$stage/auth.curl" "$stage/image.tar.gz" "$stage/Caddyfile.next"; rmdir -- "$stage"; }
rollback() {
  status=$?; trap - EXIT; set +e
  if ((status != 0)); then
    echo 'AgentParty activation failed; restoring the previous service.' >&2
    if ((new_created)); then docker rm -f "$container" >/dev/null; fi
    if ((data_backed_up)); then
      mv -- "$data" "$backup/failed-data"
      tar -xzf "$backup/data.tar.gz" -C /var/lib
    fi
    if ((renamed)); then docker rename "$previous" "$container" && docker start "$container" >/dev/null;
    elif ((old_present)); then docker start "$container" >/dev/null; fi
    if ((caddy_changed)); then cp -p -- "$backup/Caddyfile" "$config"; caddy validate --config "$config" && systemctl --no-block reload caddy && wait_reload; fi
  fi
  cleanup
  exit "$status"
}
trap rollback EXIT
command -v docker >/dev/null; command -v caddy >/dev/null
[[ "$(sha256sum "$config" | cut -d ' ' -f 1)" == "$expected_caddy_sha" ]] || { echo 'Caddy configuration changed during preparation.' >&2; exit 1; }
[[ "$(sha256sum "$stage/image.tar.gz" | cut -d ' ' -f 1)" == "$expected_image_sha" ]]
caddy validate --config "$stage/Caddyfile.next" --adapter caddyfile
if docker container inspect "$container" >/dev/null 2>&1; then
  [[ "$(docker inspect --format '{{ index .Config.Labels "com.paws.service" }}' "$container")" == 'agent-party' ]] || { echo 'Refusing to replace an unowned container.' >&2; exit 1; }
  old_present=1
else
  ! ss -H -lnt 'sport = :3847' | grep -q . || { echo 'Port 3847 is already owned by another service.' >&2; exit 1; }
fi
[[ ! -e "$backup" ]] || { echo 'Release backup already exists.' >&2; exit 1; }
install -d -m 700 "$backup"
cp -p -- "$config" "$backup/Caddyfile"
docker load --input "$stage/image.tar.gz" >/dev/null
[[ "$(docker image inspect --format '{{.Config.User}}' "$image")" == node ]] || { echo 'Image must use the non-root node user.' >&2; exit 1; }
if ((old_present)); then docker stop --time 30 "$container" >/dev/null; fi
install -d -o 1000 -g 1000 -m 700 "$data"
tar -czf "$backup/data.tar.gz" -C /var/lib paws-agent-party
data_backed_up=1
if ((old_present)); then docker rename "$container" "$previous"; renamed=1; fi
docker create --name "$container" --label com.paws.service=agent-party --label "com.paws.revision=$revision" \
  --network host --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m --restart unless-stopped --init \
  --env-file "$stage/runtime.env" --mount "type=bind,source=$data,target=$data" "$image" >/dev/null
new_created=1
docker start "$container" >/dev/null
for ((attempt=1; attempt<=30; attempt+=1)); do
  if [[ "$(curl --silent --show-error --noproxy '*' --max-time 2 --header 'Host: 47.115.228.20:8443' http://127.0.0.1:3847/agent-party/revision || true)" == "$revision" ]]; then break; fi
  sleep 1
done
[[ "$(curl --fail --silent --show-error --noproxy '*' --max-time 10 --header 'Host: 47.115.228.20:8443' http://127.0.0.1:3847/agent-party/revision)" == "$revision" ]]
install -m 644 -- "$stage/Caddyfile.next" "$config"; caddy_changed=1
systemctl --no-block reload caddy; wait_reload
origin='https://47.115.228.20:8443'
[[ "$(curl --insecure --fail --silent --show-error --noproxy '*' --max-time 15 "$origin/agent-party/revision")" == "$revision" ]]
[[ "$(curl --insecure --silent --show-error --noproxy '*' --max-time 15 --output /dev/null --write-out '%{http_code}' "$origin/agent-party/")" == 200 ]]
[[ "$(curl --insecure --silent --show-error --noproxy '*' --max-time 15 --output /dev/null --write-out '%{http_code}' "$origin/agent-party/api/paws/status")" == 401 ]]
# Public account-mode metadata is reachable; shared master key no longer grants API access.
[[ "$(curl --insecure --silent --show-error --noproxy '*' --max-time 15 "$origin/agent-party/api/access/config")" == '{"accountMode":true}' ]]
echo "AgentParty deployed: $origin/agent-party/ ($revision). Recovery backup: $backup"
REMOTE_SCRIPT
