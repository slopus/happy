#!/usr/bin/env bash
# Set up a self-hosted happy server from scratch on a Linux box.
#
# What it does:
#   - Verifies Node 20+, pnpm (via corepack), git, tmux are present
#   - Clones happy if not already cloned (HAPPY_SRC)
#   - pnpm install + builds the webapp (dist/) + downloads Caddy binary to ~/bin
#   - Writes ~/.happy/server.env with HANDY_MASTER_SECRET + paths
#   - Writes ~/.caddy/Caddyfile gating /v1/auth* with basic-auth
#   - Runs Prisma migrations once
#   - Starts happy-server and Caddy in tmux sessions
#   - Prints next-step instructions (UFW, fingerprints, client config)
#
# Requires:
#   HANDY_MASTER_SECRET             64-hex (or anything strong). Generate via `openssl rand -hex 32`.
#   HAPPY_BASIC_AUTH_USER           Basic-auth username (default: happy)
#   HAPPY_BASIC_AUTH_PASS_BCRYPT    bcrypt of password (output of `caddy hash-password --plaintext '<pass>'`)
#   HAPPY_PUBLIC_PORT               Default 3006
#   HAPPY_SRC                       Where to clone the repo (default: ~/code/happy)
#
# After it finishes, you'll need to (on the host, separately):
#   1. sudo ufw allow $HAPPY_PUBLIC_PORT/tcp
#   2. (Optional) set up TLS for browser-secure-context support
#
# Re-running this script is safe — it skips steps that have already completed.

set -euo pipefail

# Source repo-root .env if present so users have one source of truth
# (see .env.example for the full schema). Variables in the env take
# precedence over this file.
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$HERE/../.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$HERE/../.env"
    set +a
fi

HAPPY_BASIC_AUTH_USER="${HAPPY_BASIC_AUTH_USER:-happy}"
HAPPY_PUBLIC_PORT="${HAPPY_PUBLIC_PORT:-3006}"
HAPPY_SRC="${HAPPY_SRC:-$HOME/code/happy}"
CADDY_VERSION="${CADDY_VERSION:-2.8.4}"
HAPPY_HOME_DIR="${HAPPY_HOME_DIR:-$HOME/.happy}"

red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
hl()     { printf '\033[36m%s\033[0m\n' "$*"; }

need() {
    if [ -z "${!1:-}" ]; then
        red "Required env var $1 is unset. See header comment for usage."
        exit 1
    fi
}
need HANDY_MASTER_SECRET
need HAPPY_BASIC_AUTH_PASS_BCRYPT

# --- prerequisites
hl "Checking prerequisites..."
command -v git    >/dev/null || { red "git missing"; exit 1; }
command -v tmux   >/dev/null || { red "tmux missing"; exit 1; }
command -v curl   >/dev/null || { red "curl missing"; exit 1; }

# Load nvm if present
if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"
fi
command -v node >/dev/null || { red "node missing — install Node 20+ first (e.g. via nvm)"; exit 1; }

NODE_MAJOR=$(node --version | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
    red "Node 20+ required (have $(node --version))"
    exit 1
fi

if ! command -v pnpm >/dev/null; then
    hl "Enabling pnpm via corepack..."
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@latest --activate
fi

# --- clone repo
if [ ! -d "$HAPPY_SRC/packages" ]; then
    hl "Cloning happy into $HAPPY_SRC ..."
    mkdir -p "$(dirname "$HAPPY_SRC")"
    git clone --depth 1 https://github.com/slopus/happy.git "$HAPPY_SRC"
else
    hl "happy repo already at $HAPPY_SRC; using existing clone"
fi

cd "$HAPPY_SRC"
hl "Installing monorepo deps (this can take ~1-2 minutes)..."
pnpm install --frozen-lockfile

# --- build webapp (for in-server-bundle viewer)
if [ ! -f "packages/happy-app/dist/index.html" ]; then
    hl "Exporting happy-app web bundle..."
    (cd packages/happy-app && pnpm exec expo export --platform web --output-dir dist >/dev/null)
fi

# --- Caddy
mkdir -p "$HOME/bin" "$HOME/.caddy"
if [ ! -x "$HOME/bin/caddy" ]; then
    hl "Downloading Caddy v$CADDY_VERSION..."
    curl -fsSL -o /tmp/caddy.tar.gz \
        "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_amd64.tar.gz"
    tar xzf /tmp/caddy.tar.gz -C "$HOME/bin" caddy
    chmod +x "$HOME/bin/caddy"
fi

# --- env file
mkdir -p "$HAPPY_HOME_DIR/server-data"
cat > "$HAPPY_HOME_DIR/server.env" <<EOF
DB_PROVIDER=pglite
HANDY_MASTER_SECRET=$HANDY_MASTER_SECRET
PORT=3005
HOST=127.0.0.1
DATA_DIR=$HAPPY_HOME_DIR/server-data
PGLITE_DIR=$HAPPY_HOME_DIR/server-data/pglite
NODE_ENV=production
METRICS_ENABLED=false
HAPPY_STATIC_DIR=$HAPPY_SRC/packages/happy-app/dist
HAPPY_INJECT_HTML_CONFIG={"serverUrl":"http://$(hostname -I | awk '{print $1}'):$HAPPY_PUBLIC_PORT"}
EOF
chmod 600 "$HAPPY_HOME_DIR/server.env"

# --- start-script
cat > "$HOME/bin/start-happy-server.sh" <<'STARTUP'
#!/usr/bin/env bash
set -e
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd HAPPY_SRC_PLACEHOLDER/packages/happy-server
exec pnpm exec tsx --env-file=HAPPY_HOME_DIR_PLACEHOLDER/server.env ./sources/standalone.ts serve
STARTUP
sed -i "s|HAPPY_SRC_PLACEHOLDER|$HAPPY_SRC|g; s|HAPPY_HOME_DIR_PLACEHOLDER|$HAPPY_HOME_DIR|g" "$HOME/bin/start-happy-server.sh"
chmod +x "$HOME/bin/start-happy-server.sh"

# --- Caddyfile
# Optional HTTPS port — set HAPPY_TLS_PORT and HAPPY_TLS_HOST to enable.
# HAPPY_TLS_HOST must match how clients address the server (IP or DNS name)
# because Caddy issues the self-signed cert for that exact identifier.
TLS_BLOCK=""
if [ -n "${HAPPY_TLS_PORT:-}" ] && [ -n "${HAPPY_TLS_HOST:-}" ]; then
    TLS_BLOCK=$(cat <<TLS
# HTTPS on $HAPPY_TLS_PORT — gives browsers a secure context so
# window.crypto.subtle is defined and the authenticated webapp works
# without an SSH tunnel. Self-signed cert; clients accept once.
https://$HAPPY_TLS_HOST:$HAPPY_TLS_PORT {
    tls internal
    @auth path /v1/auth /v1/auth/* /v1/auth/request /v1/auth/account/request /v1/auth/account/response /v1/auth/request/status
    basic_auth @auth {
        $HAPPY_BASIC_AUTH_USER $HAPPY_BASIC_AUTH_PASS_BCRYPT
    }
    reverse_proxy 127.0.0.1:3005 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
    }
}
TLS
)
fi

cat > "$HOME/.caddy/Caddyfile" <<CADDYFILE
{
    admin off
    skip_install_trust
    auto_https disable_redirects
}

# Plain HTTP — CLI, mobile, and (for browser) only via SSH-tunneled localhost.
http://:$HAPPY_PUBLIC_PORT {
    @auth path /v1/auth /v1/auth/* /v1/auth/request /v1/auth/account/request /v1/auth/account/response /v1/auth/request/status
    basic_auth @auth {
        $HAPPY_BASIC_AUTH_USER $HAPPY_BASIC_AUTH_PASS_BCRYPT
    }
    reverse_proxy 127.0.0.1:3005 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
    }
}
$TLS_BLOCK
CADDYFILE

# --- Prisma migrate
hl "Running database migrations..."
(cd "$HAPPY_SRC/packages/happy-server" && pnpm exec tsx --env-file="$HAPPY_HOME_DIR/server.env" ./sources/standalone.ts migrate >/dev/null 2>&1)

# --- start happy-server + Caddy in tmux
hl "(Re)starting happy-server and Caddy in tmux..."
tmux kill-session -t happy-server 2>/dev/null || true
tmux kill-session -t happy-caddy  2>/dev/null || true
pkill -f 'caddy run' 2>/dev/null || true
sleep 2

tmux new-session -d -s happy-server "$HOME/bin/start-happy-server.sh 2>&1 | tee $HAPPY_HOME_DIR/server.log"
# Caddy via nohup, not tmux — tmux session was being garbage-collected when
# the ssh that launched it exited, taking Caddy down with it. nohup keeps
# Caddy detached even when the parent shell goes.
cd "$HOME/.caddy" && nohup "$HOME/bin/caddy" run --config Caddyfile > "$HOME/.caddy/caddy.log" 2>&1 < /dev/null &
disown
sleep 4

green "✓ happy-server + Caddy started in tmux."
echo
hl "Verification:"
curl -sS -o /dev/null -w "  happy-server loopback : HTTP %{http_code}\n" --max-time 5 http://127.0.0.1:3005/ || true
curl -sS -o /dev/null -w "  Caddy proxy           : HTTP %{http_code}\n" --max-time 5 "http://127.0.0.1:$HAPPY_PUBLIC_PORT/" || true
echo
hl "Next steps (manual):"
echo "  1. Open the firewall:  sudo ufw allow $HAPPY_PUBLIC_PORT/tcp"
echo "     (Ubuntu 20.04: if iptables-nft errors, switch to legacy backend:"
echo "        sudo update-alternatives --set iptables /usr/sbin/iptables-legacy)"
echo
echo "  2. Bootstrap your first client account (also runnable from another machine):"
echo "        node $HAPPY_SRC/scripts/happy-register.mjs \\"
echo "            'http://$HAPPY_BASIC_AUTH_USER:<URL-ENCODED-PASSWORD>@<HOST>:$HAPPY_PUBLIC_PORT'"
echo
echo "  3. Distribute the resulting ~/.happy/access.key to all your machines:"
echo "        scp ~/.happy/access.key <user>@<host>:~/.happy/access.key"
echo
echo "  4. For browser webapp access without an SSH tunnel:"
echo "     - either accept the SSH tunnel pattern: ssh -L $HAPPY_PUBLIC_PORT:127.0.0.1:$HAPPY_PUBLIC_PORT -N <host>"
echo "     - or add TLS on a second port (see scripts/setup-happy-server-tls.sh)"
