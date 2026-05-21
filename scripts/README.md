# Self-host setup scripts

These scripts automate the steps in [`docs/self-hosting.md`](../docs/self-hosting.md). One server-side script + per-platform client scripts + a stand-alone direct-register script. All scripts are idempotent — re-running them skips steps that already completed.

## The scripts

| Script | What it does | Where it runs |
|---|---|---|
| `setup-happy-server.sh` | Clones repo, builds webapp, installs Caddy, writes config, runs migrations, starts happy-server + Caddy in tmux | The Linux host that will be your server |
| `setup-happy-client-linux.sh` | Installs Node 20+ if missing, installs happy@1.1.10-beta.4, writes settings.json, sets up auth (copy access.key OR register fresh) | Any Linux machine that should run `happy claude` etc. |
| `setup-happy-client-windows.ps1` | Same as linux, plus optional Chrome `--app` shortcut + SSH tunnel for browser viewer | Windows PCs |
| `happy-register.mjs` | Direct-register a fresh keypair against `/v1/auth` (no browser, no QR) — used by client scripts and standalone | Anywhere with Node 20+ |

## End-to-end walkthrough

Concrete example: server on `ubuntu`, three Linux clients (`paris`, `sandiego`, `cancun`), one Windows client (local), one browser viewer.

### 0. Generate credentials (do once)

On your laptop:

```bash
# Master secret — used by happy-server to sign JWTs and HMAC service-account IDs.
# Rotating this invalidates every JWT. Treat as a long-lived secret.
MASTER_SECRET=$(openssl rand -hex 32)

# Caddy basic-auth username + password (gates only /v1/auth* — the JWT
# issuance paths). Anyone hitting your server needs this to mint a JWT.
BASIC_USER=happy
BASIC_PASS=$(openssl rand -base64 24)

# URL-encode the password for use inside URLs (/, +, = become %2F, %2B, %3D)
BASIC_PASS_URLENC=$(python3 -c "import urllib.parse; print(urllib.parse.quote(input()), end='')" <<< "$BASIC_PASS")

# Bcrypt the password (this is what Caddyfile uses).
# Caddy must be installed locally OR you can run this remotely after the
# server script downloads it for you. Replace with the actual hash output.
BASIC_PASS_BCRYPT="\$2a\$14\$..."

echo "Save these — you'll need them on every machine:"
echo "  MASTER_SECRET     = $MASTER_SECRET"
echo "  BASIC_USER        = $BASIC_USER"
echo "  BASIC_PASS        = $BASIC_PASS"
echo "  BASIC_PASS_URLENC = $BASIC_PASS_URLENC"
echo "  BASIC_PASS_BCRYPT = $BASIC_PASS_BCRYPT"
```

### 1. Set up the server

SSH into the server host:

```bash
# Copy the script to the server
scp scripts/setup-happy-server.sh ubuntu:~/

# Run it (needs the secrets you generated above)
ssh ubuntu bash <<EOF
export HANDY_MASTER_SECRET='$MASTER_SECRET'
export HAPPY_BASIC_AUTH_USER='$BASIC_USER'
export HAPPY_BASIC_AUTH_PASS_BCRYPT='$BASIC_PASS_BCRYPT'
export HAPPY_PUBLIC_PORT=3006
bash ~/setup-happy-server.sh
EOF
```

When it finishes, manually open the firewall:

```bash
ssh ubuntu "sudo ufw allow 3006/tcp"
# (If you hit `iptables-nft` errors on Ubuntu 20.04+:
#    sudo update-alternatives --set iptables /usr/sbin/iptables-legacy
#    sudo ufw disable && sudo ufw enable && sudo ufw allow 3006/tcp )
```

### 2. Bootstrap the first account

From any machine that has Node 20+ and the repo cloned:

```bash
node scripts/happy-register.mjs \
    "http://${BASIC_USER}:${BASIC_PASS_URLENC}@<HOST>:3006"
```

This writes `~/.happy/access.key` on whatever machine you run it on. **This is your account identity** — copy it to every other machine you want bound to the same account.

### 3. Set up Linux clients (paris/sandiego/cancun)

Two flavors. Pick the one that fits.

**3a. Copy the access.key from the bootstrap machine (same identity everywhere):**

```bash
for host in paris sandiego cancun; do
    scp scripts/setup-happy-client-linux.sh scripts/happy-register.mjs "$host:/tmp/"
    scp ~/.happy/access.key "$host:/tmp/_ak"
    ssh "$host" "HAPPY_SERVER_URL=http://<HOST>:3006 bash /tmp/setup-happy-client-linux.sh --access-key /tmp/_ak && rm /tmp/_ak"
done
```

**3b. Register each host as its own account (independent identities):**

```bash
for host in paris sandiego cancun; do
    scp scripts/setup-happy-client-linux.sh scripts/happy-register.mjs "$host:/tmp/"
    ssh "$host" "HAPPY_SERVER_URL=http://<HOST>:3006 HAPPY_BASIC_AUTH_URL='http://${BASIC_USER}:${BASIC_PASS_URLENC}@<HOST>:3006' bash /tmp/setup-happy-client-linux.sh --register"
done
```

### 4. Set up Windows client

```powershell
# From the Windows PC, with the repo cloned locally:
.\scripts\setup-happy-client-windows.ps1 `
    -HappyServerUrl     'http://<HOST>:3006' `
    -HappyBasicAuthUrl  "http://${BASIC_USER}:${BASIC_PASS_URLENC}@<HOST>:3006" `
    -AccessKeyPath      '\\path\to\access.key'  `
    -SshTunnelHost      '<ubuntu-ssh-alias>'    `
    -SshTunnelPort      3006 `
    -InstallShortcut    $true
```

The SSH tunnel + `localhost:3006` URL is needed for the **browser webapp** to work — Chrome/Firefox refuse to expose `window.crypto.subtle` on plain HTTP non-localhost origins, so the authenticated webapp goes blank otherwise. The CLI doesn't have this restriction.

For an existing Windows machine, `-AccessKeyPath` is most convenient. For a fresh one with no existing identity, swap it for `-Register`.

### 5. Verify

```bash
for h in paris sandiego cancun; do
    ssh "$h" "happy doctor 2>&1 | grep -iE 'Server URL|Authent'"
done
# expect: Server URL: http://<HOST>:3006 + Authentication: ✓ Authenticated
```

On Windows, double-click the "Happy (Multi)" desktop shortcut → Chrome app-mode opens the multiplexer view at `http://localhost:3006/multi`.

## Known gotchas (documented in [`docs/self-hosting.md`](../docs/self-hosting.md) troubleshooting matrix)

- **Inline `user:pass@` in `settings.json` breaks Bearer-auth on `/v1/*`** — axios overrides the explicit `Authorization: Bearer` with URL-derived `Basic`. The scripts deliberately strip inline credentials.
- **Legacy `happy-coder` npm package** on the same machine shadows the newer `happy` (PATH ordering or shell hash). The scripts ensure `happy` resolves correctly; if you still see 401s on `/v1/machines`, run `npm uninstall -g happy-coder` and delete `~/.happy/daemon.state.json`.
- **`window.crypto.subtle` undefined on plain HTTP non-localhost** — the authenticated webapp blanks out. Use the SSH tunnel + `localhost:<port>` (the scripts set this up), or add TLS to Caddy on a second port.
- **Multiple Caddy procs on same port via SO_REUSEPORT** — if you ever start Caddy twice without killing the old one, kernel load-balances requests between configs and you get random 401s. Always `pkill -f 'caddy run'` before starting a new one.
- **`ufw allow` fails with `iptables-nft` error** on Ubuntu 20.04+ — switch iptables to legacy backend (`sudo update-alternatives --set iptables /usr/sbin/iptables-legacy`), then `sudo ufw disable && sudo ufw enable`.

## Customization

All settings are env-var-driven and the scripts default to sensible values. Read the header comment of each script for the full list. Common overrides:

- `HAPPY_PUBLIC_PORT` — the public-facing port Caddy listens on (default 3006). Must match across server + client.
- `HAPPY_CLI_VERSION` — happy CLI version to install (default 1.1.10-beta.4). Pinned because the `server` subcommand was removed in later 1.3.x.
- `HAPPY_NODE_INSTALL_PATH` — where the Linux client script puts a standalone Node tarball if Node 20+ is missing (default `~/local`).
- `HAPPY_SRC` — where the server script clones the repo (default `~/code/happy`).
