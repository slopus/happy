#!/usr/bin/env bash

set -Eeuo pipefail

# A pinned release gets its own Compose files. Like Compose, prefer the shell's tag over .env.
image_tag="${RAKAZO_IMAGE_TAG-}"
if [[ -z "${RAKAZO_IMAGE_TAG+x}" && -f .env ]]; then
  image_tag=$(sed -nE "s/^[[:space:]]*(export[[:space:]]+)?RAKAZO_IMAGE_TAG[[:space:]]*=[[:space:]]*[\"']?([^\"'#[:space:]]*).*/\2/p" .env | tail -n 1)
fi
download_ref=main
if [[ "$image_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  download_ref="$image_tag"
fi
DOWNLOAD_BASE="${RAKAZO_DOWNLOAD_BASE:-https://raw.githubusercontent.com/elie222/rakazo/${download_ref}/infra/compose}"
while [[ "$DOWNLOAD_BASE" == */ ]]; do
  DOWNLOAD_BASE="${DOWNLOAD_BASE%/}"
done
case "$DOWNLOAD_BASE" in
  https://*) ;;
  *)
    echo "Rakazo setup failed: RAKAZO_DOWNLOAD_BASE must use https." >&2
    exit 1
    ;;
esac
readonly DOWNLOAD_BASE

readonly COMPOSE_FILE="docker-compose.images.yml"
# Optional operator overlay, layered after the base file the way Compose itself does by default.
readonly OVERRIDE_FILE="docker-compose.override.yml"
readonly ENV_EXAMPLE=".env.images.example"
readonly ENV_FILE=".env"
readonly EGRESS_SCRIPT="restrict-computer-egress.sh"

prepare_only=false
skip_existing=false
pull_never=false
offline=false
if [[ "${RAKAZO_DOWNLOAD_SKIP_EXISTING:-}" == "1" ]]; then
  skip_existing=true
fi
if [[ "${RAKAZO_PULL_NEVER:-}" == "1" ]]; then
  pull_never=true
fi

for arg in "$@"; do
  case "$arg" in
    --prepare-only)
      prepare_only=true
      ;;
    --local)
      skip_existing=true
      ;;
    --pull-never)
      pull_never=true
      ;;
    --offline)
      # Air-gap bootstrap: keep local Compose/env files and do not pull images.
      skip_existing=true
      pull_never=true
      offline=true
      ;;
    *)
      echo "Usage: bash install-images.sh [--prepare-only] [--local] [--pull-never] [--offline]" >&2
      exit 2
      ;;
  esac
done

temporary_file=""
cleanup() {
  if [[ -n "$temporary_file" ]]; then
    rm -f -- "$temporary_file"
  fi
}
trap cleanup EXIT

fail() {
  echo "Rakazo setup failed: $*" >&2
  exit 1
}

required_files=("$COMPOSE_FILE" "$ENV_EXAMPLE")
if [[ "$offline" == true ]]; then
  for filename in "${required_files[@]}"; do
    [[ -f "$filename" ]] || fail "--offline requires local ${filename}; copy it into the working directory first."
  done
else
  command -v curl >/dev/null 2>&1 || fail "'curl' is required."
fi

for command_name in docker openssl; do
  command -v "$command_name" >/dev/null 2>&1 || fail "'$command_name' is required."
done
docker compose version >/dev/null 2>&1 || fail "the Docker Compose plugin is required."

# Optional proxy knobs from an existing .env (operators often set them there for
# containers). Do not override values already present in the shell. Treat each
# HTTP/HTTPS/NO_PROXY pair as one family so either case in the shell wins.
# Within .env, later assignments for a family win (shell presence is snapshotted
# before the file is read). Comment stripping is quote-aware so `#` inside
# matching quotes is kept; this is not a full dotenv parser.
load_proxy_vars_from_env_file() {
  local file="$1"
  local line key value
  local i c quote out
  local shell_http=0 shell_https=0 shell_no=0
  [[ -f "$file" ]] || return 0
  [[ -n "${HTTP_PROXY+x}" || -n "${http_proxy+x}" ]] && shell_http=1
  [[ -n "${HTTPS_PROXY+x}" || -n "${https_proxy+x}" ]] && shell_https=1
  [[ -n "${NO_PROXY+x}" || -n "${no_proxy+x}" ]] && shell_no=1
  while IFS= read -r line || [[ -n "$line" ]]; do
    # Windows/.editorconfig CRLF: drop trailing CR so quoted values still match.
    line="${line%$'\r'}"
    out=""
    quote=""
    for ((i = 0; i < ${#line}; i++)); do
      c="${line:i:1}"
      if [[ -n "$quote" ]]; then
        # Inside double quotes, treat \" and \\ as escaped so \# stays in-value.
        if [[ "$quote" == '"' && "$c" == '\' ]] && ((i + 1 < ${#line})); then
          out+="$c"
          i=$((i + 1))
          out+="${line:i:1}"
          continue
        fi
        out+="$c"
        [[ "$c" == "$quote" ]] && quote=""
      elif [[ "$c" == "'" || "$c" == '"' ]]; then
        quote="$c"
        out+="$c"
      elif [[ "$c" == "#" ]]; then
        break
      else
        out+="$c"
      fi
    done
    line="$out"
    [[ "$line" =~ ^[[:space:]]*(HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
      value="${value:1:${#value}-2}"
      value="${value//\\\"/\"}"
      value="${value//\\\\/\\}"
    elif [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
      value="${value:1:${#value}-2}"
    fi
    case "$key" in
      HTTP_PROXY|http_proxy)
        if ((shell_http)); then
          continue
        fi
        unset -v HTTP_PROXY http_proxy
        ;;
      HTTPS_PROXY|https_proxy)
        if ((shell_https)); then
          continue
        fi
        unset -v HTTPS_PROXY https_proxy
        ;;
      NO_PROXY|no_proxy)
        if ((shell_no)); then
          continue
        fi
        unset -v NO_PROXY no_proxy
        ;;
    esac
    export "${key}=${value}"
  done <"$file"
}

# curl uses lowercase http_proxy for http:// URLs; many Mainland hosts only export HTTP_PROXY.
sync_curl_proxy_env() {
  if [[ -n "${HTTP_PROXY+x}" && -z "${http_proxy+x}" ]]; then
    export http_proxy="$HTTP_PROXY"
  fi
  if [[ -n "${HTTPS_PROXY+x}" && -z "${https_proxy+x}" ]]; then
    export https_proxy="$HTTPS_PROXY"
  fi
  if [[ -n "${NO_PROXY+x}" && -z "${no_proxy+x}" ]]; then
    export no_proxy="$NO_PROXY"
  fi
}

prepare_proxy_env() {
  load_proxy_vars_from_env_file "$ENV_FILE"
  sync_curl_proxy_env
}
prepare_proxy_env

curl_download() {
  local url="$1"
  local out="$2"
  local attempt
  local max_attempts=3

  if curl --help all 2>/dev/null | grep -q -- '--retry-all-errors'; then
    curl -fsSL --proto-redir =https --retry 3 --retry-delay 2 --retry-all-errors "$url" -o "$out"
    return $?
  fi

  attempt=1
  while [[ "$attempt" -le "$max_attempts" ]]; do
    if curl -fsSL --proto-redir =https "$url" -o "$out"; then
      return 0
    fi
    if [[ "$attempt" -eq "$max_attempts" ]]; then
      return 1
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  return 1
}

download() {
  local filename="$1"
  local url="${DOWNLOAD_BASE}/${filename}"

  if [[ "$skip_existing" == true && -e "$filename" ]]; then
    echo "Using local ${filename}"
    return 0
  fi
  if [[ "$offline" == true ]]; then
    fail "--offline cannot download missing ${filename}; copy it into the working directory first."
  fi

  temporary_file=$(mktemp "./${filename}.tmp.XXXXXX")
  if ! curl_download "$url" "$temporary_file"; then
    fail "could not download ${filename} from ${url}. Set HTTP_PROXY/HTTPS_PROXY in the shell or .env (NO_PROXY for localhost), or pre-place the file and use --local / --offline."
  fi
  mv -- "$temporary_file" "$filename"
  temporary_file=""
}

create_env() {
  local generated_encryption_key=false
  umask 077
  temporary_file=$(mktemp "./${ENV_FILE}.tmp.XXXXXX")

  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "POSTGRES_PASSWORD=")
        printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 16)"
        ;;
      "POSTGRES_APP_PASSWORD=")
        printf 'POSTGRES_APP_PASSWORD=%s\n' "$(openssl rand -hex 16)"
        ;;
      "BETTER_AUTH_SECRET=")
        printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)"
        ;;
      "ENCRYPTION_KEY=")
        printf 'ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)"
        generated_encryption_key=true
        ;;
      "SCREEN_PROXY_SECRET=")
        printf 'SCREEN_PROXY_SECRET=%s\n' "$(openssl rand -hex 32)"
        ;;
      "SANDBOX_SUPERVISOR_TOKEN=")
        printf 'SANDBOX_SUPERVISOR_TOKEN=%s\n' "$(openssl rand -hex 32)"
        ;;
      *)
        printf '%s\n' "$line"
        ;;
    esac
  done < "$ENV_EXAMPLE" > "$temporary_file"

  chmod 600 "$temporary_file"
  mv -- "$temporary_file" "$ENV_FILE"
  temporary_file=""
  echo "Created .env with random secrets."
  # Name the variable and file only: the key itself never reaches the terminal or its logs.
  if [[ "$generated_encryption_key" == true ]]; then
    echo "Back up ENCRYPTION_KEY from ${PWD}/${ENV_FILE}. Encrypted content cannot be recovered without it."
  fi
}

# Secrets added after a .env was created. Append them so an upgrade still starts,
# leaving every existing line untouched.
add_missing_secrets() {
  if ! grep -Eq '^POSTGRES_APP_PASSWORD=[^[:space:]]' "$ENV_FILE"; then
    [[ ! -s "$ENV_FILE" || -z "$(tail -c 1 "$ENV_FILE")" ]] || printf '\n' >> "$ENV_FILE"
    printf 'POSTGRES_APP_PASSWORD=%s\n' "$(openssl rand -hex 16)" >> "$ENV_FILE"
    echo "Added POSTGRES_APP_PASSWORD to .env."
  fi
}

validate_required_secrets() {
  if ! docker compose --env-file "$ENV_FILE" "${compose_files[@]}" -f - config --environment <<'YAML' | awk '
    BEGIN {
      required["POSTGRES_PASSWORD"] = 1
      required["POSTGRES_APP_PASSWORD"] = 1
      required["BETTER_AUTH_SECRET"] = 1
      required["ENCRYPTION_KEY"] = 1
      required["SCREEN_PROXY_SECRET"] = 1
      required["SANDBOX_SUPERVISOR_TOKEN"] = 1
    }
    {
      name = $0
      sub(/=.*/, "", name)
      if (!(name in required)) next
      seen[name]++

      value = $0
      sub(/^[^=]*=/, "", value)
      gsub(/[[:space:]]/, "", value)
      if (value != "") nonempty[name]++
    }
    END {
      for (name in required) {
        if (seen[name] != 1 || nonempty[name] != 1) exit 1
      }
    }
  '
services:
  api:
    environment:
      _RAKAZO_VALIDATE_POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}
      _RAKAZO_VALIDATE_POSTGRES_APP_PASSWORD: ${POSTGRES_APP_PASSWORD:?Set POSTGRES_APP_PASSWORD in .env}
      _RAKAZO_VALIDATE_BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?Set BETTER_AUTH_SECRET in .env}
      _RAKAZO_VALIDATE_ENCRYPTION_KEY: ${ENCRYPTION_KEY:?Set ENCRYPTION_KEY in .env}
      _RAKAZO_VALIDATE_SCREEN_PROXY_SECRET: ${SCREEN_PROXY_SECRET:?Set SCREEN_PROXY_SECRET in .env}
      _RAKAZO_VALIDATE_SANDBOX_SUPERVISOR_TOKEN: ${SANDBOX_SUPERVISOR_TOKEN:?Set SANDBOX_SUPERVISOR_TOKEN in .env}
YAML
  then
    fail "set every required secret in .env to a non-empty value."
  fi
}

# The Compose file passes each container only the settings it names. Say which .env settings it
# does not name, such as TELEGRAM_BOT_TOKEN_<NAME>, rather than let an upgrade drop them silently.
warn_unpassed_settings() {
  local key unpassed=""
  while IFS= read -r key; do
    [[ "$key" == COMPOSE_* ]] || grep -qw -e "$key" "$COMPOSE_FILE" ${override_present:+"$OVERRIDE_FILE"} || unpassed+=" $key"
  done < <(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/p' "$ENV_FILE" | sort -u)
  [[ -n "$unpassed" ]] || return 0
  echo "Warning: no container receives these .env settings:${unpassed}." >&2
  echo "List them in an override file; see Settings with names you choose in docs/self-host-configuration.md." >&2
}

# Why this host cannot take the restricted-egress firewall rules; empty when it can.
egress_rules_unsupported() {
  local os security
  [[ "$(uname -s)" == Linux ]] || { echo "Docker runs in a VM on this OS"; return; }
  os=$(docker info --format '{{.OperatingSystem}}' 2>/dev/null) || { echo "docker info failed"; return; }
  [[ "$os" != *"Docker Desktop"* ]] || { echo "Docker Desktop keeps its networks in a VM"; return; }
  security=$(docker info --format '{{json .SecurityOptions}}' 2>/dev/null) || security=""
  [[ "$security" != *rootless* ]] || { echo "rootless Docker"; return; }
  command -v iptables >/dev/null 2>&1 || echo "iptables is not installed"
}

# Compose defaults computers to restricted egress, which only works once the host
# rules are in place. Install them where possible; otherwise record open explicitly
# so computers keep working, and say what that leaves reachable.
configure_computer_egress() {
  local reason
  # Compose takes the shell value over .env, so either one is the operator's choice.
  if [[ -n "${SANDBOX_COMPUTER_EGRESS:-}" ]] ||
    grep -Eq '^[[:space:]]*SANDBOX_COMPUTER_EGRESS=' "$ENV_FILE"; then
    return 0
  fi
  reason=$(egress_rules_unsupported)
  if [[ -z "$reason" ]] && ! (trap cleanup EXIT; download "$EGRESS_SCRIPT"); then
    reason="$EGRESS_SCRIPT could not be downloaded"
  fi
  if [[ -z "$reason" ]]; then
    echo "Restricting bot computer egress; installing host firewall rules needs root."
    if bash "./$EGRESS_SCRIPT"; then
      printf '\nSANDBOX_COMPUTER_EGRESS=restricted\n' >>"$ENV_FILE"
      return 0
    fi
    reason="the host firewall rules could not be installed"
  fi
  printf '\nSANDBOX_COMPUTER_EGRESS=open\n' >>"$ENV_FILE"
  echo "Warning: bot computers can reach this host, its LAN and cloud metadata ($reason)." >&2
  echo "See Restricted computer egress in docs/self-host-docker-computers.md." >&2
}

remove_replaced_images() {
  local ref repo id tag repos=" "
  while IFS= read -r ref; do
    repo="${ref%@*}"
    [[ "${repo##*/}" != *:* ]] || repo="${repo%:*}"
    repo="${repo#docker.io/}"
    repos+="${repo#library/} "
  done < <(docker compose --env-file "$ENV_FILE" "${compose_files[@]}" config --images 2>/dev/null)
  [[ "$repos" != " " ]] || return 0
  while read -r id repo tag; do
    [[ "$tag" == "<none>" && "$repos" == *" ${repo} "* ]] || continue
    docker image rm "$id" >/dev/null 2>&1 || true
  done < <(docker image ls --no-trunc --format '{{.ID}} {{.Repository}} {{.Tag}}' 2>/dev/null)
}

for filename in "${required_files[@]}"; do
  download "$filename"
done

compose_files=(-f "$COMPOSE_FILE")
override_present=""
if [[ -f "$OVERRIDE_FILE" ]]; then
  compose_files+=(-f "$OVERRIDE_FILE")
  override_present=1
  echo "Using ${OVERRIDE_FILE}."
fi

if [[ -e "$ENV_FILE" ]]; then
  echo "Keeping existing .env."
  add_missing_secrets
else
  create_env
fi

validate_required_secrets
warn_unpassed_settings

if [[ "$prepare_only" == true ]]; then
  echo "Rakazo files are ready. Edit .env, then run: bash install-images.sh"
  exit 0
fi

configure_computer_egress

prepare_proxy_env
if [[ "$pull_never" == true ]]; then
  echo "Skipping image pull (--pull-never / --offline); images must already be on this Docker host."
else
  if ! docker compose --env-file "$ENV_FILE" "${compose_files[@]}" pull; then
    fail "could not pull images. Shell HTTP_PROXY often does not reach the Docker daemon. Configure daemon proxy/registry-mirrors, set image env vars to a reachable registry, or preload images then compose up with --pull never."
  fi
fi
# `--wait` without `--wait-timeout` can hang on one-shot services (Compose < 2.7)
# or never return if a healthcheck stays red (Compose < 2.17). Prefer both flags.
compose_up_help=$(docker compose up --help 2>/dev/null || true)
up_pull_args=()
if [[ "$pull_never" == true ]]; then
  if grep -q -- '--pull' <<<"$compose_up_help"; then
    up_pull_args=(--pull never)
  else
    echo "cannot enforce pull-never on this Compose version; startup fails if an image is missing locally" >&2
  fi
fi
# bash 3.2 + set -u: "${arr[@]}" aborts when arr is empty.
if grep -q -- '--wait-timeout' <<<"$compose_up_help"; then
  echo "Waiting for healthy services."
  docker compose --env-file "$ENV_FILE" "${compose_files[@]}" up -d ${up_pull_args[@]+"${up_pull_args[@]}"} --wait --wait-timeout 300
else
  docker compose --env-file "$ENV_FILE" "${compose_files[@]}" up -d ${up_pull_args[@]+"${up_pull_args[@]}"}
fi
remove_replaced_images

echo "Rakazo is starting at http://127.0.0.1:5173"
