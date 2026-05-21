# Self-hosting happy on a single Linux box

This guide walks through standing up the happy backend on one Linux host, gating it behind a reverse proxy with HTTP basic auth, and configuring the CLI + web client to use it. It's deliberately scoped to a *single-box* deployment — for production-grade infrastructure see `docs/deployment.md`.

The approach trades the convenience of the maintainers' public server for:

- Sessions never leave your hosts unencrypted (already true via E2E encryption, but the server is yours too)
- No third-party SaaS in the path
- A scoped credential per client (basic-auth password) rather than spreading SSH keys

## Architecture

```
   ┌─────────────────────────────────────────┐
   │  Linux host (the "server box")          │
   │                                         │
   │  ┌─────────┐   loopback   ┌──────────┐  │
   │  │ Caddy   │ ───────────► │ happy-   │  │
   │  │ :PUBLIC │              │ server   │  │
   │  │         │              │ :3005    │  │
   │  └────▲────┘              └────┬─────┘  │
   │       │                        │        │
   │       │                  pglite (embedded postgres)
   │       │                        │        │
   │       │                  ~/.happy/server-data/
   │       │                                  │
   └───────┼──────────────────────────────────┘
           │
           │ HTTP/WS on :PUBLIC
           │
   ┌───────┴────────┐  ┌───────────────┐  ┌────────────┐
   │  Local PC      │  │  Remote VMs   │  │  Browser   │
   │  happy CLI     │  │  happy CLI    │  │  webapp    │
   └────────────────┘  └───────────────┘  └────────────┘
```

Two processes on the server:
- **happy-server** (Fastify + Socket.IO) bound to **127.0.0.1:3005** — never reachable from outside
- **Caddy** bound to **0.0.0.0:`<PUBLIC_PORT>`** — basic-auth gate in front of `/v1/auth*` paths only, transparent for everything else

**Why basic auth on `/v1/auth*` only, not the whole `/v1/*`?** The HTTP `Authorization` header can carry only one scheme. Once a client holds a JWT, every other `/v1/*` request sends `Authorization: Bearer <jwt>`. If Caddy also expects `Authorization: Basic …` on those paths, the Bearer scheme wins and Caddy 401s — breaking every authenticated API call. Two-layer auth on the same header is impossible.

The fix is to gate ONLY the JWT-issuance endpoints (`/v1/auth`, `/v1/auth/request`, `/v1/auth/account/request`, etc.). Without basic-auth credentials, no one can mint a JWT, so the rest of `/v1/*` stays effectively protected — happy-server's `authenticate` middleware rejects any unsigned/forged Bearer.

`socket.io-client` is another reason the rest of `/v1/*` can't be basic-auth-gated: it doesn't honor `user:pass@host` URL userinfo on its polling/WebSocket handshake (verified empirically). Realtime sync would break if those paths needed Basic auth.

## Server-side setup

### Prerequisites

- Linux host, your user has SSH access. Sudo *only* needed once, to open a firewall port.
- Node.js 20+ (install via `nvm`, system package, or [official tarball](https://nodejs.org/dist/) into `~/local`)
- `git`, `curl`, `tmux` (or `systemd` user units)
- Optional: Docker, only if you want to run the server in a container instead

### 1. Clone the repository and install deps

```bash
cd ~/code   # or wherever you keep checkouts
git clone https://github.com/slopus/happy.git
cd happy

# enable pnpm via corepack (ships with Node 20+)
corepack enable
corepack prepare pnpm@latest --activate

pnpm install --frozen-lockfile
```

### 2. Generate a master secret

This signs the server's JWTs and encrypts service-account tokens at rest. **Keep it secret, keep it stable.** Rotating it invalidates every issued JWT.

```bash
openssl rand -hex 32
```

### 3. Write the server env file

```bash
mkdir -p ~/.happy/server-data
cat > ~/.happy/server.env <<'EOF'
DB_PROVIDER=pglite
HANDY_MASTER_SECRET=<paste the hex output from step 2>
PORT=3005
HOST=127.0.0.1
DATA_DIR=/home/<your-user>/.happy/server-data
PGLITE_DIR=/home/<your-user>/.happy/server-data/pglite
NODE_ENV=production
METRICS_ENABLED=false
EOF
chmod 600 ~/.happy/server.env
```

### 4. Run migrations + start the server

```bash
cd packages/happy-server
pnpm exec tsx --env-file=$HOME/.happy/server.env ./sources/standalone.ts migrate
```

Wrap the serve command in a tmux session (or a systemd user service) so it survives SSH disconnects:

```bash
cat > ~/bin/start-happy-server.sh <<'EOF'
#!/usr/bin/env bash
set -e
# load your Node manager if needed
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd $HOME/code/happy/packages/happy-server
exec pnpm exec tsx --env-file=$HOME/.happy/server.env ./sources/standalone.ts serve
EOF
chmod +x ~/bin/start-happy-server.sh

tmux new-session -d -s happy-server '~/bin/start-happy-server.sh 2>&1 | tee ~/.happy/server.log'
```

Verify with `curl http://127.0.0.1:3005/` — you should see `Welcome to Happy Server!`.

### 5. (Optional) Build the webapp for browser-based viewing

You can skip this step entirely if you only want to use the mobile app or the
CLI — the bootstrap flow below uses `scripts/happy-register.mjs` and never
needs the webapp. The webapp is only needed for an in-browser session viewer.

```bash
cd ~/code/happy/packages/happy-app
pnpm exec expo export --platform web --output-dir dist
```

This produces `dist/` with `index.html` + bundled assets. Tell the server to serve them by adding two lines to `~/.happy/server.env` and **restarting** the tmux session:

```bash
HAPPY_STATIC_DIR=/home/<your-user>/code/happy/packages/happy-app/dist
HAPPY_INJECT_HTML_CONFIG={"serverUrl":"https://<your-public-domain-or-ip>:<PUBLIC_PORT>"}
```

The `HAPPY_INJECT_HTML_CONFIG` value is injected as `window.__HAPPY_CONFIG__` into `index.html` so the bundled webapp knows where to call the API. It should match the public URL clients use — *not* `127.0.0.1:3005`. **Do not include credentials in this URL**; the webapp would expose them to anyone who fetches the HTML.

> Heads-up: the published `happy` npm CLI's webapp pairing UI (`/terminal/connect`)
> assumes you already have an authenticated device to approve from. On a brand-new
> self-host that's a chicken-and-egg. The register script in the bootstrap
> section below sidesteps all of that — strongly recommended.

### 6. Set up Caddy reverse proxy with basic auth

Install Caddy (user-space binary works, no sudo for install):

```bash
mkdir -p ~/bin ~/.caddy
curl -sSL -o /tmp/caddy.tar.gz \
  https://github.com/caddyserver/caddy/releases/download/v2.8.4/caddy_2.8.4_linux_amd64.tar.gz
tar xzf /tmp/caddy.tar.gz -C ~/bin caddy
chmod +x ~/bin/caddy
```

Generate a strong password and bcrypt-hash it:

```bash
PASS=$(openssl rand -base64 24)
echo "PASS=$PASS"          # save this for clients
~/bin/caddy hash-password --plaintext "$PASS"
```

Write the Caddyfile:

```caddyfile
{
    auto_https off
    admin off
}

:<PUBLIC_PORT> {
    # Gate ONLY the auth-issuance endpoints with basic auth.
    # The HTTP Authorization header can carry only one scheme — so
    # gating the full /v1/* would conflict with the CLI's Bearer JWT
    # auth. Issued JWTs are verified by happy-server's middleware on
    # all other /v1/* paths, so they're still protected.
    @auth path /v1/auth /v1/auth/* /v1/auth/request /v1/auth/account/request /v1/auth/account/response /v1/auth/request/status

    basic_auth @auth {
        <username> <bcrypt-hash-from-above>
    }

    reverse_proxy 127.0.0.1:3005 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
    }
}
```

Validate + run:

```bash
~/bin/caddy validate --config ~/.caddy/Caddyfile --adapter caddyfile
tmux new-session -d -s happy-caddy '~/bin/caddy run --config ~/.caddy/Caddyfile 2>&1 | tee ~/.caddy/caddy.log'
```

### 7. Open the firewall

`<PUBLIC_PORT>` won't be reachable from outside until you open it. If you're using UFW:

```bash
sudo ufw allow <PUBLIC_PORT>/tcp
sudo ufw status
```

**Common gotcha on Ubuntu 20.04+ with iptables-nft backend:** `ufw allow` may fail with `iptables v1.8.7 (nf_tables): Could not fetch rule set generation id`. Fix:

```bash
sudo update-alternatives --set iptables /usr/sbin/iptables-legacy
sudo update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy
sudo ufw disable && sudo ufw enable
sudo ufw allow <PUBLIC_PORT>/tcp
```

### 8. Smoke-test from a remote machine

```bash
curl -sS -o /dev/null -w 'no-auth: %{http_code}\n' \
  http://<HOST>:<PUBLIC_PORT>/v1/auth -X POST
# expect: 401

curl -sS -o /dev/null -w 'with-auth: %{http_code}\n' \
  -u '<username>:<password>' \
  http://<HOST>:<PUBLIC_PORT>/v1/auth -X POST \
  -H 'Content-Type: application/json' -d '{}'
# expect: 400 (Caddy passed; happy-server rejected empty body — fine)

curl -sS -o /dev/null -w 'webapp: %{http_code}\n' \
  http://<HOST>:<PUBLIC_PORT>/
# expect: 200 (the webapp index.html, ungated)
```

If all three are as expected, the server is ready to accept clients.

### 9. TLS — strongly recommended if you want browser webapp access

**You need TLS if anyone will use the webapp in a browser.** Modern browsers
gate `window.crypto.subtle` to "secure contexts" — HTTPS, or
`localhost`/`127.0.0.1`. The happy webapp uses `crypto.subtle.digest` during
the authenticated-user encryption-key derivation, so without TLS the
authenticated webapp dies with `Cannot read properties of undefined (reading
'digest')` immediately after sign-in, rendering a blank page.

The CLI (Node.js) doesn't have this restriction; it works against plain HTTP.

Two workable patterns:

**A. SSH local-forward + `http://localhost:<PUBLIC_PORT>`.** No server change; each browser-using client opens an SSH tunnel: `ssh -L <PUBLIC_PORT>:127.0.0.1:<PUBLIC_PORT> -N <HOST>`. Then opens `http://localhost:<PUBLIC_PORT>/`. localhost is treated as a secure context regardless of HTTP.

**B. TLS at Caddy.** Easiest path is a public DNS name pointed at the host plus port 80/443 open:

```caddyfile
your.domain.tld {
    @api path /v1/* /v1
    basic_auth @api {
        <username> <bcrypt-hash>
    }
    reverse_proxy 127.0.0.1:3005
}
```

Caddy auto-provisions a Let's Encrypt cert. Drop the `auto_https off` global from the previous Caddyfile.

For internal-only deployments without a public domain, add a second site block with `tls internal` on a separate port:

```caddyfile
https://:<TLS_PORT> {
    tls internal
    @auth path /v1/auth /v1/auth/* /v1/auth/request /v1/auth/account/request /v1/auth/account/response /v1/auth/request/status
    basic_auth @auth { <username> <bcrypt-hash> }
    reverse_proxy 127.0.0.1:3005
}
```

Open `<TLS_PORT>` in UFW. Each browser will warn once about the self-signed cert — accept it and the webapp works fully (secure context + valid HTTPS).

## Client-side setup

### Install the CLI (per machine)

Stick to the version that ships the `happy server` subcommand we used for bundled webapp lookups:

```bash
npm install -g happy@1.1.10-beta.4
happy --version   # 1.1.10-beta.4
```

If `npm install -g` fails for permission reasons (system Node), point npm at a user-writable prefix:

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH=$HOME/.npm-global/bin:$PATH' >> ~/.bashrc   # or .zshrc
```

### Point the CLI at your server

Write `~/.happy/settings.json` (Windows: `%USERPROFILE%\.happy\settings.json`):

```json
{
  "schemaVersion": 2,
  "onboardingCompleted": false,
  "serverUrl": "http://<username>:<url-encoded-password>@<HOST>:<PUBLIC_PORT>",
  "webappUrl": "http://<username>:<url-encoded-password>@<HOST>:<PUBLIC_PORT>"
}
```

**URL-encode the password** if it contains `/`, `+`, `=`, `:`, `@`, etc.:

```
/  →  %2F
+  →  %2B
=  →  %3D
```

The CLI uses `serverUrl` for HTTP+WebSocket; `webappUrl` is what `happy auth login` opens in your browser.

Verify with `happy doctor` — you should see the URL echoed back under `Server URL:`.

**On the server box itself**, the CLI can bypass Caddy and talk to the loopback server directly:

```json
{
  "serverUrl": "http://127.0.0.1:3005",
  "webappUrl": "http://127.0.0.1:3005"
}
```

## First-time bootstrap (shortcut: just register the CLI directly)

A fresh self-hosted server has no accounts yet. The published CLI's
`happy auth login` opens a webapp pairing page that *assumes you already have
an authenticated device* — chicken-and-egg. Browsers also block fetch URLs
with embedded credentials, strip `user:pass@` silently on some platforms, and
cache stale `auth_credentials` in localStorage. The painless way around all of
that is the included register script — it POSTs to `/v1/auth` once and writes
`~/.happy/access.key` directly.

```bash
# Make sure ~/.happy/settings.json on this machine has serverUrl pointing
# at your Caddy URL (with URL-encoded basic-auth password embedded).
node scripts/happy-register.mjs

# Or pass the URL explicitly if settings.json isn't set up yet:
node scripts/happy-register.mjs 'http://<username>:<url-encoded-password>@<HOST>:<PUBLIC_PORT>'
```

What it does:
1. Generates a fresh 32-byte NaCl seed and the matching sign keypair.
2. Signs a random challenge with the keypair.
3. POSTs `{publicKey, challenge, signature}` to `/v1/auth` with `Authorization: Basic …` (it splits out the URL userinfo because Node 22's fetch rejects URLs with embedded credentials).
4. The server creates an `Account` row keyed by the public key and returns a JWT.
5. The script writes `{secret, token}` to `~/.happy/access.key` in the legacy format the CLI expects.

After it succeeds, `happy doctor` reports **`Authenticated`** — no browser, no webapp, no QR code.

### Alternative: webapp pairing (only if you want it)

If you do want to bind the CLI through the webapp (e.g. to demo the pairing
flow), build + deploy the webapp per step 5 above, then in this exact order:

1. Open `http://<HOST>:<PUBLIC_PORT>/` in a modern browser (Firefox <115 has bundle-parse issues — use Chrome or current Firefox).
2. Complete the basic-auth dialog at the network layer.
3. Click **"Create Account"** on the homepage. This calls `/v1/auth` directly via the webapp and stashes credentials in localStorage.
4. Run `happy auth login` on the CLI (or set `HAPPY_WEBAPP_URL` to your `http://user:url-encoded-pass@host:port` if you're on the npm-published CLI before `1.1.11`, since that version's `webappUrl` setting isn't honored).
5. The CLI prints a `/terminal/connect#key=…` URL — open it in the **same** browser session so the webapp's localStorage credentials are reused.
6. Click **"Accept Connection"** (or **"Create Account & Accept"** if you skipped step 3 — that branch is in the patched terminal-connect screen).

## Putting multiple machines on the same account

Once any machine has `~/.happy/access.key`, copy it to every other machine to share the identity:

```bash
scp ~/.happy/access.key user@other-host:~/.happy/access.key
```

`happy doctor` on the other side then reports `Authentication: Authenticated`, and `happy claude`/`codex`/`gemini` invocations register sessions to the same account.

**Trade-off**: every host with this key acts as the same identity on the server. Compromise of one host gives an attacker the identity on all of them. Acceptable for hosts you control; not appropriate for multi-user. For per-host revocability, register each machine independently — just run `node scripts/happy-register.mjs` from each (each gets its own keypair, each is a separate account). Then if you want them to see each other's sessions, you'd add a friendship/sharing layer (out of scope for this guide).

## Operations

### Restart server / proxy

```bash
ssh <server> "tmux kill-session -t happy-server && tmux new-session -d -s happy-server '~/bin/start-happy-server.sh 2>&1 | tee ~/.happy/server.log'"
ssh <server> "tmux kill-session -t happy-caddy && tmux new-session -d -s happy-caddy '~/bin/caddy run --config ~/.caddy/Caddyfile 2>&1 | tee ~/.caddy/caddy.log'"
```

For production prefer systemd user services with `Restart=on-failure` over tmux.

### Rotate the basic-auth password

1. Generate new password + bcrypt hash with `caddy hash-password`
2. Replace the hash in `~/.caddy/Caddyfile`
3. Reload Caddy: `tmux send-keys -t happy-caddy C-c` + restart (or `caddy reload`)
4. Update each client's `settings.json` with the new URL-encoded password

### Switch back to the maintainers' public server

Delete `~/.happy/settings.json` (or remove the `serverUrl` / `webappUrl` keys). The CLI falls back to `https://api.cluster-fluster.com` and `https://app.happy.engineering`. Your local `~/.happy/access.key` is bound to *your self-hosted server's account* though — log out (`happy auth logout`) and pair fresh against the public server.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `happy auth login` opens browser → "failed to connect terminal" | Webapp isn't authenticated yet — `/terminal/connect` requires an existing account | Open the homepage `/` first, click **Create Account**, then re-run `happy auth login` |
| Browser prompt: "site asks for username and password" repeatedly | Browser isn't caching basic-auth credentials for the origin | Some browsers don't cache cross-tab — visit `/` once, complete the prompt, leave the tab open before triggering CLI auth |
| `with-auth` curl returns 401 instead of 400 | Wrong password / wrong base64 of the bcrypt | Re-run `caddy hash-password`, paste exact output into Caddyfile, restart Caddy |
| `with-auth` curl returns 400 (good) but CLI still 401s | Password not URL-encoded properly in `settings.json` | `/ → %2F`, `+ → %2B`, `= → %3D`. Use `encodeURIComponent` in Node to verify |
| Realtime sync fails / sockets disconnect immediately | Caddy basic-auth might be gating `/socket.io/*` | Confirm Caddyfile gates only `/v1/*` paths — sockets must pass through ungated |
| Server logs report Prisma migration errors after upgrade | `pnpm exec tsx ./sources/standalone.ts migrate` not re-run after pulling | Re-run migrate, then restart serve |
| `sudo ufw allow` fails with `iptables-nft` error | Kernel/iptables backend mismatch | Switch iptables to legacy (see step 7) |
| Non-interactive `ssh host "cmd"` returns no output | Shell init silently exec's another shell or redirects stdout, OR sshd cloud-init drop-in / PAM rule swallows the channel in command-arg mode | Diagnose: pipe via stdin (`echo 'cmd' \| ssh -T -x -o BatchMode=yes host`) — if that works, it's host-side. Inspect `~/.zshrc` for a top-level p10k-instant-prompt block (add `[[ $- == *i* ]] \|\| return` at top) and `~/.bashrc` for missing interactive-shell guard. If neither, suspect sshd: `sudo cat /etc/ssh/sshd_config.d/*.conf` and `sudo grep -RnE 'ForceCommand\|PermitTTY' /etc/pam.d/sshd /etc/pam.d/ssh*`. The stdin-pipe workaround is fine to ship long-term if the root cause isn't readily fixable. |

## Related docs

- [`docs/deployment.md`](deployment.md) — production deployment with external Postgres + Redis + S3 + Kubernetes manifests
- [`docs/encryption.md`](encryption.md) — how E2E encryption and the master secret interact
- [`docs/user-identity.md`](user-identity.md) — how a single account is bound across CLIs, mobile, and external services
