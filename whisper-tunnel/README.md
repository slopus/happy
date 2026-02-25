# Whisper Tunnel — TLS Reverse Proxy

HTTPS termination proxy for testing Happy Dev + Whisper STT from an iPhone on the LAN. iOS Safari requires HTTPS for microphone access (`getUserMedia`).

## What it does

Single nginx container that:
- Terminates TLS using the `*.seas.house` wildcard cert
- Proxies `https://happy-dev.seas.house` → Expo dev server on `localhost:8081`
- Proxies `https://whisper.seas.house` → Whisper STT API on `localhost:8300`
- Supports WebSocket upgrade (Expo hot reload)
- Allows up to 50MB audio uploads for Whisper

## Prerequisites

- Docker running in WSL2
- Expo dev server running (`yarn web` from `packages/happy-app`, port 8081)
- Whisper STT container running (port 8300)
- DNS records pointing to WSL2's trusted VLAN IP (10.23.7.50):
  - `happy-dev.seas.house` → 10.23.7.50
  - `whisper.seas.house` → 10.23.7.50
- WSL2 VLAN interfaces must be up (WSLAttachSwitch for VLAN 40)

## Usage

```bash
cd whisper-tunnel
docker compose up -d
```

To stop:
```bash
docker compose down
```

## TLS Certificates

The `certs/` directory contains the `*.seas.house` wildcard cert (Let's Encrypt, managed by Nginx Proxy Manager on TrueNAS). These are **gitignored**.

If certs are missing or expired, copy fresh ones from erying-0:

```bash
scp -i ~/mission-control/.keys/erying root@erying-0:/mnt/docker-ephemeral/volumes/happy-relay_npm_certs/_data/live/npm-1/fullchain.pem certs/
scp -i ~/mission-control/.keys/erying root@erying-0:/mnt/docker-ephemeral/volumes/happy-relay_npm_certs/_data/live/npm-1/privkey.pem certs/
```

Current cert expires: **April 6, 2026**.

## App Configuration

Set the Whisper URL to use the HTTPS endpoint:

```bash
EXPO_PUBLIC_WHISPER_URL=https://whisper.seas.house
```

Or change it at runtime in the app's server settings (MMKV key: `custom-whisper-url`).

## Architecture

```
iPhone (trusted VLAN)
    │
    │ HTTPS (port 443)
    ▼
WSL2 eth2 (10.23.7.50, VLAN 40)
    │
    │ Docker port mapping 443:443
    ▼
nginx container (whisper-tunnel)
    │
    ├─ happy-dev.seas.house → http://host.docker.internal:8081 (Expo)
    └─ whisper.seas.house   → http://host.docker.internal:8300 (Whisper)
```

No reverse SSH tunnels. No Cloudflare. WSL2 has a direct VLAN interface on the trusted network.
