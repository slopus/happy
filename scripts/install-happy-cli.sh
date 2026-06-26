#!/usr/bin/env bash
# Install/upgrade the Happy CLI from the gearshift/happy monorepo on Linux/macOS.
#
# Defaults are for Jon's self-hosted Happy deployment. Override with env vars:
#   HAPPY_REPO_URL=https://github.com/gearshift/happy.git
#   HAPPY_REPO_DIR=$HOME/happy
#   HAPPY_REF=main
#   HAPPY_SERVER_URL=https://happy-api.tail146e68.ts.net
#   HAPPY_WEBAPP_URL=https://happy.tail146e68.ts.net
#   HAPPY_CLI_BIN_DIR=$HOME/.local/bin
#   HAPPY_CLI_INSTALL_MODE=user   # user | npm-link

set -euo pipefail

REPO_URL="${HAPPY_REPO_URL:-https://github.com/gearshift/happy.git}"
INSTALL_DIR="${HAPPY_REPO_DIR:-$HOME/happy}"
REF="${HAPPY_REF:-main}"
CLI_DIR="$INSTALL_DIR/packages/happy-cli"
SERVER_URL="${HAPPY_SERVER_URL:-https://happy-api.tail146e68.ts.net}"
WEBAPP_URL="${HAPPY_WEBAPP_URL:-https://happy.tail146e68.ts.net}"
BIN_DIR="${HAPPY_CLI_BIN_DIR:-$HOME/.local/bin}"
INSTALL_MODE="${HAPPY_CLI_INSTALL_MODE:-user}"

log() {
  printf '\n==> %s\n' "$*"
}

fail() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

check_node_version() {
  need_command node
  local major
  major="$(node -p "Number(process.versions.node.split('.')[0])")"
  if [ "$major" -lt 20 ]; then
    fail "Node.js 20+ is required; found $(node --version)"
  fi
}

remove_untracked_file() {
  local relative_path="$1"
  local description="$2"
  local path="$INSTALL_DIR/$relative_path"

  if [ ! -e "$path" ]; then
    return
  fi

  if git -C "$INSTALL_DIR" ls-files -- "$relative_path" | grep -q .; then
    return
  fi

  log "Removing untracked $description at $path"
  rm -f "$path"
}

remove_generated_files() {
  remove_untracked_file "package-lock.json" "npm lockfile"
  remove_untracked_file "yarn.lock" "Yarn lockfile"
  remove_untracked_file "packages/happy-cli/package-lock.json" "CLI npm lockfile"
  remove_untracked_file "packages/happy-cli/yarn.lock" "CLI Yarn lockfile"
  remove_untracked_file "upgrade-happy-cli.sh" "downloaded legacy upgrade script"
  remove_untracked_file "install-happy-cli.sh" "downloaded installer script"
}

validate_repo_origin() {
  local origin
  origin="$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)"
  case "$origin" in
    *github.com/gearshift/happy.git|*github.com:gearshift/happy.git|*github.com/slopus/happy.git|*github.com:slopus/happy.git)
      ;;
    *)
      fail "$INSTALL_DIR is a git checkout, but its origin is '$origin' instead of the Happy monorepo.
Use HAPPY_REPO_DIR=$HOME/happy-monorepo or move the old checkout out of the way."
      ;;
  esac
}

ensure_repo() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    log "Updating existing happy monorepo checkout at $INSTALL_DIR"
    validate_repo_origin
    remove_generated_files
    dirty="$(git -C "$INSTALL_DIR" status --porcelain)"
    [ -z "$dirty" ] || fail "$INSTALL_DIR has uncommitted changes:
$dirty
Commit/stash them or set HAPPY_REPO_DIR to a clean checkout."
    git -C "$INSTALL_DIR" fetch origin "$REF"
    git -C "$INSTALL_DIR" checkout "$REF"
    git -C "$INSTALL_DIR" pull --ff-only origin "$REF"
  elif [ -e "$INSTALL_DIR" ]; then
    fail "$INSTALL_DIR exists but is not a git checkout"
  else
    log "Cloning $REPO_URL into $INSTALL_DIR"
    git clone --branch "$REF" "$REPO_URL" "$INSTALL_DIR"
  fi

  [ -d "$CLI_DIR" ] || fail "Expected CLI package at $CLI_DIR, but it was not found"
}

build_cli() {
  log "Installing monorepo dependencies and building Happy CLI"
  cd "$INSTALL_DIR"
  corepack enable
  corepack pnpm install --frozen-lockfile
  corepack pnpm --filter happy build
}

write_unix_wrapper() {
  local name="$1"
  local target="$2"

  cat > "$BIN_DIR/$name" <<EOF
#!/usr/bin/env bash
export HAPPY_SERVER_URL="${SERVER_URL}"
export HAPPY_WEBAPP_URL="${WEBAPP_URL}"
exec node "${target}" "\$@"
EOF
  chmod +x "$BIN_DIR/$name"
}

install_user_wrappers() {
  log "Installing user-local wrappers in $BIN_DIR"
  mkdir -p "$BIN_DIR"
  write_unix_wrapper happy "$CLI_DIR/bin/happy.mjs"
  if [ -f "$CLI_DIR/bin/happy-mcp.mjs" ]; then
    write_unix_wrapper happy-mcp "$CLI_DIR/bin/happy-mcp.mjs"
  fi

  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      printf '\nNOTE: %s is not currently on PATH. Add this to your shell profile:\n' "$BIN_DIR"
      printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
      ;;
  esac
}

install_npm_link() {
  log "Linking CLI package with npm link"
  cd "$CLI_DIR"
  npm link

  printf '\nNOTE: npm link does not bake in server URLs. Ensure these are in your shell profile:\n'
  printf '  export HAPPY_SERVER_URL="%s"\n' "$SERVER_URL"
  printf '  export HAPPY_WEBAPP_URL="%s"\n' "$WEBAPP_URL"
}

main() {
  need_command git
  need_command corepack
  need_command npm
  check_node_version
  ensure_repo
  build_cli

  case "$INSTALL_MODE" in
    user)
      install_user_wrappers
      ;;
    npm-link)
      install_npm_link
      ;;
    *)
      fail "Unknown HAPPY_CLI_INSTALL_MODE=$INSTALL_MODE; expected 'user' or 'npm-link'"
      ;;
  esac

  log "Verifying installed CLI"
  if [ "$INSTALL_MODE" = "user" ]; then
    "$BIN_DIR/happy" --version || true
  else
    happy --version || true
  fi

  cat <<EOF

Done.

Happy monorepo checkout: $INSTALL_DIR
Happy CLI package: $CLI_DIR
Command: happy
Server URL: $SERVER_URL
Web app URL: $WEBAPP_URL

If this is the first install on this host, run:
  happy auth
EOF
}

main "$@"
