# Whisper Tunnel — TLS Reverse Proxy + Local Whisper STT

HTTPS termination proxy + GPU-accelerated Whisper STT for testing the Happy app from an iPhone on the LAN. iOS Safari requires HTTPS for microphone access (`getUserMedia`).

## What it does

Two-container compose stack:

- **whisper-stt** (speaches, CUDA) — Faster Whisper transcription on GPU, OpenAI-compatible API
- **whisper-tunnel** (nginx) — TLS termination using the `*.seas.house` wildcard cert

Nginx routes:
- `https://happy-dev.seas.house` → Expo dev server on `host.docker.internal:8081`
- `https://whisper.seas.house` → whisper-stt container on Docker network (`whisper:8000`)

Only the transcription endpoint (`/v1/audio/transcriptions`) is exposed — everything else is rejected.

## Prerequisites

- Docker running in WSL2 with NVIDIA GPU passthrough
- Expo dev server running (`yarn web` from `packages/happy-app`, port 8081)
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
    ├─ happy-dev.seas.house → http://host.docker.internal:8081 (Expo dev server on host)
    └─ whisper.seas.house   → http://whisper:8000 (whisper-stt container via Docker network)
```

No reverse SSH tunnels. No Cloudflare. WSL2 has a direct VLAN interface on the trusted network.

## Whisper model

Default model: `Systran/faster-whisper-base` (set via `WHISPER__MODEL` in docker-compose.yml). Model weights are cached in the `whisper-models` Docker volume so they survive container recreates.

## Troubleshooting

**502 Bad Gateway**: Check that whisper-stt is running and has finished loading (`docker logs whisper-stt`). Model download + CUDA init takes ~10 seconds on first start. If you changed `nginx/default.conf`, restart nginx: `docker compose restart nginx`.
