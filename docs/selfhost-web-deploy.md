# Self-host the Paws Web App

> This guide deploys the Paws web client on your own server, including the production build, Caddy static hosting, same-origin API/WebSocket proxying, trusted HTTPS, updates, and rollback.

[中文版](selfhost-web-deploy.zh-CN.md)

## 1. Target architecture

The finished deployment exposes one HTTPS origin:

```text
Browser
  │
  │ https://paws.example.com
  ▼
Caddy
  ├─ /v1/*, /v2/*, /v3/*, /v4/*, /files/*, /health
  │      └─ reverse proxy to Paws Server (127.0.0.1:3005 by default)
  └─ every other path
         └─ serve packages/happy-app/dist
```

Keep the Web App and Paws Server on the same origin whenever possible. This avoids extra CORS configuration and keeps authentication, attachments, and WebSocket traffic consistent.

## 2. Prerequisites

Build machine:

- Git
- Node.js 20 or newer
- pnpm 10.11.0
- A Paws source checkout

Server:

- Linux
- Caddy 2
- SSH access
- A running Paws Server on `127.0.0.1:3005`
- A domain name or a stable public IPv4/IPv6 address
- Public access to ports 80 and 443

Deploy the backend first if it is not running:

- [Backend deployment](deployment.md)
- [Intranet self-hosting](selfhost-intranet-deploy.md)

> [!IMPORTANT]
> The Web App is a client. A page that renders successfully does not prove that the sync server, machine presence, messages, attachments, or WebSocket path are working.

## 3. Choose an HTTPS strategy

### 3.1 Domain name: recommended

Point a DNS record at the server:

```text
paws.example.com -> your server's public IP
```

Caddy can then obtain and renew a publicly trusted certificate automatically. This is the simplest production option.

### 3.2 Public IP address only

Let’s Encrypt now issues publicly trusted IPv4 and IPv6 certificates. IP certificates must use the `shortlived` profile and are valid for roughly 160 hours, so automated renewal is mandatory.

Requirements:

- The address must be publicly reachable.
- Validation must use `http-01` or `tls-alpn-01`, not `dns-01`.
- Port 80 or 443 must be reachable from the Internet.
- A changed IP requires a new certificate.
- The ACME client must support certificate profiles and IP address identifiers.

Official references:

- [Let’s Encrypt: IP address certificates are generally available](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability.html)
- [Certbot: request an IP address certificate](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)

### 3.3 Self-signed certificates

A self-signed certificate encrypts traffic, but browsers and normal clients do not trust its identity by default. Use one only for local development, isolated networks, temporary testing, or environments that explicitly distribute a private trust anchor.

Prefer a domain certificate or a Let’s Encrypt public-IP certificate for Internet-facing production deployments.

## 4. Build the Web App manually

### 4.1 Clone and install

```bash
git clone https://github.com/wangjs-jacky/happy.git
cd happy
corepack enable
pnpm install --frozen-lockfile
```

### 4.2 Set the public origin

The build must contain the exact Paws Server origin that users will visit:

```bash
export PAWS_WEB_ORIGIN="https://paws.example.com"
```

For a public IP:

```bash
export PAWS_WEB_ORIGIN="https://203.0.113.10"
```

Include a non-standard port when applicable:

```bash
export PAWS_WEB_ORIGIN="https://203.0.113.10:8443"
```

> [!WARNING]
> `http://host:3005` and `https://host` are different origins. Keep the Web App, CLI, and mobile clients on the same external origin to avoid inconsistent authentication, attachment URLs, and WebSocket connections.

### 4.3 Type-check and export

```bash
pnpm --filter happy-app typecheck

CI=1 \
APP_ENV=production \
EXPO_PUBLIC_HAPPY_SERVER_URL="$PAWS_WEB_ORIGIN" \
pnpm --filter happy-app export:web
```

The production files are written to:

```text
packages/happy-app/dist/
```

Verify the output:

```bash
test -f packages/happy-app/dist/index.html
find packages/happy-app/dist -maxdepth 2 -type f | head
```

Optional local preview:

```bash
pnpm dlx serve packages/happy-app/dist
```

## 5. First upload

The examples use:

```text
SSH host: deploy@paws.example.com
Release root: /var/www/paws-web
Current release: /var/www/paws-web/current
```

Prepare the directory:

```bash
ssh deploy@paws.example.com \
  'sudo install -d -o "$USER" -g "$USER" /var/www/paws-web &&
   install -d /var/www/paws-web/current'
```

The SSH user must be able to create and rename entries inside the release root.
The helper only writes below `/var/www/paws-web/`; it does not require making
all of `/var/www` writable.

Upload the build:

```bash
tar -C packages/happy-app/dist -czf /tmp/paws-web.tar.gz .
scp /tmp/paws-web.tar.gz deploy@paws.example.com:/tmp/
ssh deploy@paws.example.com \
  'tar -xzf /tmp/paws-web.tar.gz -C /var/www/paws-web/current &&
   rm /tmp/paws-web.tar.gz'
```

Verify:

```bash
ssh deploy@paws.example.com \
  'test -f /var/www/paws-web/current/index.html && echo "Web files ready"'
```

## 6. Configure Caddy

### 6.1 Domain with automatic HTTPS

Create `/etc/caddy/Caddyfile`:

```caddyfile
paws.example.com {
    encode zstd gzip

    @backend path /v1/* /v2/* /v3/* /v4/* /files/* /health
    reverse_proxy @backend 127.0.0.1:3005

    root * /var/www/paws-web/current
    try_files {path} /index.html
    file_server
}
```

The SPA fallback is required so direct navigation to `/session/...` returns `index.html`.

Validate and reload:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### 6.2 Public IP with Let’s Encrypt

Use Certbot 5.4 or newer. Start by serving the `http-01` challenge on port 80:

```caddyfile
http://203.0.113.10 {
    handle /.well-known/acme-challenge/* {
        root * /var/www/letsencrypt
        file_server
    }

    respond "HTTPS certificate bootstrap" 200
}
```

```bash
sudo install -d -m 755 /var/www/letsencrypt
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Test against staging first:

```bash
sudo certbot certonly \
  --staging \
  --preferred-profile shortlived \
  --webroot \
  --webroot-path /var/www/letsencrypt \
  --ip-address 203.0.113.10
```

Then request the trusted production certificate without `--staging`:

```bash
sudo certbot certonly \
  --preferred-profile shortlived \
  --webroot \
  --webroot-path /var/www/letsencrypt \
  --ip-address 203.0.113.10
```

Certbot's private-key directory is normally root-only. Copy the certificate into
a Caddy-owned location:

```bash
sudo install -d -m 750 -o root -g caddy /etc/caddy/certs
sudo install -m 640 -o root -g caddy \
  /etc/letsencrypt/live/203.0.113.10/fullchain.pem \
  /etc/caddy/certs/paws-ip-fullchain.pem
sudo install -m 640 -o root -g caddy \
  /etc/letsencrypt/live/203.0.113.10/privkey.pem \
  /etc/caddy/certs/paws-ip-privkey.pem
```

Configure HTTPS:

```caddyfile
http://203.0.113.10 {
    handle /.well-known/acme-challenge/* {
        root * /var/www/letsencrypt
        file_server
    }

    redir https://203.0.113.10{uri} permanent
}

https://203.0.113.10 {
    tls /etc/caddy/certs/paws-ip-fullchain.pem /etc/caddy/certs/paws-ip-privkey.pem
    encode zstd gzip

    @backend path /v1/* /v2/* /v3/* /v4/* /files/* /health
    reverse_proxy @backend 127.0.0.1:3005

    root * /var/www/paws-web/current
    try_files {path} /index.html
    file_server
}
```

Enable renewal and reload Caddy after deployment:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl enable --now certbot.timer
sudo install -d /etc/letsencrypt/renewal-hooks/deploy
sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-caddy.sh >/dev/null <<'EOF'
#!/usr/bin/env sh
set -eu
install -m 640 -o root -g caddy \
  /etc/letsencrypt/live/203.0.113.10/fullchain.pem \
  /etc/caddy/certs/paws-ip-fullchain.pem
install -m 640 -o root -g caddy \
  /etc/letsencrypt/live/203.0.113.10/privkey.pem \
  /etc/caddy/certs/paws-ip-privkey.pem
systemctl reload caddy
EOF
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-caddy.sh
sudo certbot renew --dry-run
```

> [!IMPORTANT]
> An IP address certificate lasts only about six days. Verify the renewal timer and Caddy reload hook instead of relying on manual renewal.
> If your distribution does not provide `certbot.timer`, configure an equivalent
> scheduled renewal using that distribution's Certbot instructions.

## 7. Verify the deployment

### HTTPS and HTML

```bash
curl --fail --show-error --silent \
  --output /dev/null \
  --write-out 'HTTP=%{http_code} TLS=%{ssl_verify_result}\n' \
  "$PAWS_WEB_ORIGIN/"
```

Expected:

```text
HTTP=200 TLS=0
```

### Backend proxy

```bash
curl --fail "$PAWS_WEB_ORIGIN/health"
```

This must return backend health data, not `index.html`.

### SPA routes

```bash
curl --fail --silent "$PAWS_WEB_ORIGIN/session/test-route" \
  | grep -q '<title>Paws</title>'
```

### WebSocket path

After signing in:

1. Machine and session lists render.
2. Presence changes update.
3. Session messages arrive in real time.
4. `/v1/updates` does not continuously fail in browser developer tools.

## 8. Atomic updates and rollback

Do not overwrite the live directory in place. Use:

```text
/var/www/paws-web/current                    current release
/var/www/paws-web/current.next-<release>     staged release
/var/www/paws-web/current.backup-<release>   previous release
```

Manual release:

```bash
# Local
tar -C packages/happy-app/dist -czf /tmp/paws-web-release.tar.gz .
shasum -a 256 /tmp/paws-web-release.tar.gz
scp /tmp/paws-web-release.tar.gz deploy@paws.example.com:/tmp/

# Server
mkdir /var/www/paws-web/current.next-<release>
tar -xzf /tmp/paws-web-release.tar.gz \
  -C /var/www/paws-web/current.next-<release>
test -f /var/www/paws-web/current.next-<release>/index.html

mv /var/www/paws-web/current /var/www/paws-web/current.backup-<release>
mv /var/www/paws-web/current.next-<release> /var/www/paws-web/current
```

Rollback:

```bash
mv /var/www/paws-web/current /var/www/paws-web/current.failed-<release>
mv /var/www/paws-web/current.backup-<release> /var/www/paws-web/current
```

Caddy does not need a restart after a directory switch.

## 9. Deployment helper

The repository includes a helper that builds, hashes, uploads, stages, and atomically switches the release while keeping the previous version:

```bash
PAWS_WEB_ORIGIN="https://paws.example.com" \
PAWS_DEPLOY_HOST="deploy@paws.example.com" \
PAWS_DEPLOY_PATH="/var/www/paws-web/current" \
pnpm web:deploy
```

Optional variables:

```text
PAWS_DEPLOY_PORT     SSH port, default 22
PAWS_SKIP_BUILD=1    Reuse the current dist directory
```

The helper does not install Caddy, modify the firewall/Caddyfile, delete backups, or publish files to object storage/CDN.

## 10. Optional object storage or CDN

After the single-server deployment is stable, large immutable assets may be moved to object storage/CDN:

```text
/_expo/*
/assets/*
/*.wasm
/favicon*.ico
/metadata.json
```

Rules:

1. Keep `index.html` uncached or on a short cache.
2. Content-hashed JS, fonts, and images may use long-lived caching.
3. Upload new assets before switching `index.html`.
4. Do not immediately delete old hashed assets.
5. Keep API and `/v1/updates` on the same public origin.

## 11. Troubleshooting

### The page loads, but authentication or machines fail

Check the build-time `EXPO_PUBLIC_HAPPY_SERVER_URL` and the Caddy matchers for `/v1/*`, `/v2/*`, and `/v3/*`.

### Refreshing `/session/...` returns 404

Add:

```caddyfile
try_files {path} /index.html
```

### WebSocket connection fails

Make sure `/v1/updates` reaches `reverse_proxy` instead of the static SPA fallback.

### The browser reports an unsafe certificate

Inspect the certificate:

```bash
openssl s_client -connect paws.example.com:443 -servername paws.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -dates -ext subjectAltName
```

Common causes:

- A self-signed certificate is still installed.
- The SAN does not contain the visited domain or IP.
- Short-lived IP certificate renewal failed.
- The current browser tab still holds the previous TLS connection.

### The old page remains after deployment

Check the script hash referenced by the live `index.html`, and do not give `index.html` a long cache lifetime.

## 12. Checklist

- [ ] Paws Server `/health` works.
- [ ] `PAWS_WEB_ORIGIN` is the complete public HTTPS origin.
- [ ] `packages/happy-app/dist/index.html` exists.
- [ ] Caddy proxies `/v1/*`, `/v2/*`, `/v3/*`, `/v4/*`, `/files/*`, and `/health`.
- [ ] Every other route uses the SPA fallback.
- [ ] The browser does not need to bypass a certificate warning.
- [ ] `curl` reports `HTTP=200 TLS=0`.
- [ ] IP certificate renewal and the Caddy reload hook are verified.
- [ ] Updates use staging, SHA256 verification, an atomic switch, and a retained backup.

## Summary

The most reliable Paws Web deployment is:

1. Run Paws Server.
2. Prefer a domain with Caddy automatic HTTPS.
3. Build the Web App with its final public origin.
4. Use one Caddy instance for same-origin API/WebSocket proxying and static files.
5. Release through staging, checksum verification, atomic switching, and rollback backups.
6. Use a short-lived Let’s Encrypt public-IP certificate only when no domain is available.
