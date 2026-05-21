# Self-host setup scripts

These scripts automate the steps in [`docs/self-hosting.md`](../docs/self-hosting.md): one server-side script, per-platform client scripts, and a stand-alone direct-register script. All scripts are idempotent — re-running them skips steps that already completed.

## One source of truth: `.env`

Copy [`.env.example`](../.env.example) at the repo root to `.env` and fill in real values. `.env` is gitignored; never commit it.

Each script auto-sources `.env` if present, so you set values *once*:

```bash
cp .env.example .env
$EDITOR .env
```

Required fields (full schema in `.env.example`):

| Variable | What it is | Where it's used |
|---|---|---|
| `HAPPY_SERVER_HOST` | Public host/IP of your server | Client serverUrl, register-script base |
| `HAPPY_PUBLIC_PORT` | Port Caddy listens on (default 3006) | Server config, client serverUrl |
| `HAPPY_BASIC_AUTH_USER` | Caddy basic-auth username (default `happy`) | Server Caddyfile, register URL |
| `HAPPY_BASIC_AUTH_PASS` | Plaintext password | (Reference only; not used by Caddy directly) |
| `HAPPY_BASIC_AUTH_PASS_URLENC` | URL-encoded password | Building `http://user:url-enc-pass@host` URLs |
| `HAPPY_BASIC_AUTH_PASS_BCRYPT` | bcrypt of the password (Caddy verifies against this) | Server Caddyfile |
| `HANDY_MASTER_SECRET` | 32-byte hex (`openssl rand -hex 32`); signs JWTs | Server only |
| `HAPPY_SERVER_SSH` | SSH config alias of the server | Tunnel + scripted server-side ops |
| `HAPPY_CLIENT_SSH_LIST` | Whitespace-separated SSH aliases of clients | Iterating over hosts to configure |

## The scripts

| Script | What it does | Where it runs |
|---|---|---|
| `setup-happy-server.sh` | Clones repo, builds webapp, installs Caddy, writes config, runs migrations, starts happy-server + Caddy in tmux | Linux host that will be your server |
| `setup-happy-client-linux.sh` | Installs Node 20+ if missing, installs `happy@$HAPPY_CLI_VERSION`, writes settings.json, sets up auth (copy access.key OR register fresh) | Any Linux machine that should run `happy claude` |
| `setup-happy-client-windows.ps1` | Same as Linux, plus optional Chrome `--app` shortcut + persistent SSH local-forward for the browser viewer | Windows PCs |
| `happy-register.mjs` | Direct-register a fresh keypair against `/v1/auth` (no browser, no QR) — used by client scripts and standalone | Anywhere with Node 20+ |

## End-to-end walkthrough

Concrete deploy: one server (`$HAPPY_SERVER_SSH` in your `.env`), N Linux clients, one Windows client, browser viewer.

### 0. Fill out `.env`

```bash
cp .env.example .env
# Edit fill-ins. To produce the values:
openssl rand -hex 32              # HANDY_MASTER_SECRET
openssl rand -base64 24           # HAPPY_BASIC_AUTH_PASS
# Then to produce HAPPY_BASIC_AUTH_PASS_URLENC + BCRYPT, see below.
```

URL-encode the password:
```bash
python3 -c "import urllib.parse,os;print(urllib.parse.quote(os.environ['HAPPY_BASIC_AUTH_PASS']))" < /dev/null
```
bcrypt the password (after the server script has placed `caddy` in `~/bin` on the server, run once):
```bash
ssh "$HAPPY_SERVER_SSH" "~/bin/caddy hash-password --plaintext '$HAPPY_BASIC_AUTH_PASS'"
```

Paste the outputs back into `.env`.

### 1. Set up the server

```bash
set -a; . ./.env; set +a   # load .env into current shell

scp scripts/setup-happy-server.sh "$HAPPY_SERVER_SSH:~/"
ssh "$HAPPY_SERVER_SSH" "
    HANDY_MASTER_SECRET='$HANDY_MASTER_SECRET' \
    HAPPY_BASIC_AUTH_USER='$HAPPY_BASIC_AUTH_USER' \
    HAPPY_BASIC_AUTH_PASS_BCRYPT='$HAPPY_BASIC_AUTH_PASS_BCRYPT' \
    HAPPY_PUBLIC_PORT='$HAPPY_PUBLIC_PORT' \
    bash ~/setup-happy-server.sh
"
ssh "$HAPPY_SERVER_SSH" "sudo ufw allow $HAPPY_PUBLIC_PORT/tcp"
# (Ubuntu 20.04 iptables-nft fallout? → docs/self-hosting.md troubleshooting.)
```

### 2. Bootstrap your account

```bash
node scripts/happy-register.mjs "$HAPPY_BASIC_AUTH_URL"
# writes ~/.happy/access.key on your local machine — this is your identity
```

### 3. Set up Linux clients

Two flavors. Pick whichever fits your threat model.

**3a. One identity across all hosts** (compromised host gives the attacker the identity everywhere; acceptable for hosts you control):

```bash
for host in $HAPPY_CLIENT_SSH_LIST; do
    scp scripts/setup-happy-client-linux.sh scripts/happy-register.mjs "$host:/tmp/"
    scp ~/.happy/access.key "$host:/tmp/_ak"
    ssh "$host" "HAPPY_SERVER_URL='$HAPPY_SERVER_URL' \
                 bash /tmp/setup-happy-client-linux.sh --access-key /tmp/_ak && rm /tmp/_ak"
done
```

**3b. Per-host identity** (each host independent — friend each other in-app if you want cross-host visibility):

```bash
for host in $HAPPY_CLIENT_SSH_LIST; do
    scp scripts/setup-happy-client-linux.sh scripts/happy-register.mjs "$host:/tmp/"
    ssh "$host" "HAPPY_SERVER_URL='$HAPPY_SERVER_URL' \
                 HAPPY_BASIC_AUTH_URL='$HAPPY_BASIC_AUTH_URL' \
                 bash /tmp/setup-happy-client-linux.sh --register"
done
```

### 4. Set up Windows client

```powershell
# Loads .env if present; flags shown for clarity.
.\scripts\setup-happy-client-windows.ps1 `
    -AccessKeyPath    'C:\path\to\access.key' `
    -InstallShortcut  $true
```

The script auto-starts a persistent SSH local-forward (`-L 3006:127.0.0.1:3006 -N $HAPPY_SSH_TUNNEL_HOST`) and points the Chrome shortcut at `http://localhost:3006/multi`. **The localhost address matters for the browser** — `window.crypto.subtle` is gated to secure contexts (HTTPS or localhost), and the authenticated webapp uses it to derive content keys. Plain HTTP on a public IP blanks the page.

If you can't set up an SSH tunnel, the alternative is TLS at Caddy (see `docs/self-hosting.md` § "TLS — strongly recommended if you want browser webapp access").

### 5. Verify

```bash
for h in $HAPPY_CLIENT_SSH_LIST; do
    ssh "$h" "happy doctor 2>&1 | grep -iE 'Server URL|Authent'"
done
# expect for each: Server URL: $HAPPY_SERVER_URL + Authentication: ✓ Authenticated
```

Double-click the **Happy (Multi)** desktop shortcut on the Windows PC — multiplexer view should load.

## Common gotchas (full matrix in [`docs/self-hosting.md`](../docs/self-hosting.md))

- **Inline `user:pass@` in `settings.json` breaks Bearer-auth on `/v1/*`** — axios overrides explicit `Authorization: Bearer` with URL-derived `Basic`. Scripts deliberately keep credentials out of `settings.json`.
- **Legacy `happy-coder` 0.13.x npm package** shadows the newer `happy` (PATH order or shell hash table). If you still see 401s on `/v1/machines`: `npm uninstall -g happy-coder` and delete `~/.happy/daemon.state.json`.
- **`window.crypto.subtle` undefined on plain HTTP non-localhost** — authenticated webapp blanks out. SSH local-forward + localhost (default in the Windows script), or add TLS to Caddy.
- **Multiple Caddy procs via SO_REUSEPORT** — kernel randomly balances; one with old config 401s, the other 200s. Always `pkill -f 'caddy run'` before starting a new one. The server script does this for you.

## Customization

Most values are env-driven via `.env`. For one-off overrides without editing the file, pass `VAR=value` ahead of the script invocation:

```bash
HAPPY_CLI_VERSION=1.1.10-beta.5 bash scripts/setup-happy-client-linux.sh --register
```
