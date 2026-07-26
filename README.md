<div align="center">
  <img src="/.github/paws-mascot.jpg" width="300" alt="Paws mascot — a marmot in a paw-print hoodie">

  <h1>Paws</h1>

  <h4>Control the AI coding agents running on your computer — right from your phone.</h4>

  <p>
    Run <code>paws claude</code> or <code>paws codex</code> on your computer, then watch progress,
    send instructions and approve permissions from the mobile or web app.<br>
    End-to-end encrypted. Fully self-hostable.
  </p>

[![npm](https://img.shields.io/npm/v/%40wangjs-jacky%2Fpaws?label=%40wangjs-jacky%2Fpaws&color=f59e0b)](https://www.npmjs.com/package/@wangjs-jacky/paws)
[![Android APK](https://img.shields.io/github/v/release/wangjs-jacky/happy?label=Android%20APK&color=34d399)](https://github.com/wangjs-jacky/happy/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[🌐 **Website**](https://paws-landing-eo4.pages.dev) • [🖥️ **Web App**](https://47.115.228.20:8443/) • [🚀 **Deploy Web**](docs/selfhost-web-deploy.md) • [📱 **Android APK**](https://github.com/wangjs-jacky/happy/releases) • [📦 **CLI on npm**](https://www.npmjs.com/package/@wangjs-jacky/paws) • [📚 **Getting Started**](docs/getting-started.md) • [🇨🇳 **中文**](README_CN.md)

</div>

---

> **Paws** is an independently maintained product and codebase that originated from
> [Happy](https://github.com/slopus/happy). It has its own app builds, CLI package,
> release pipeline, roadmap, and website. The retained GitHub fork relationship is historical
> attribution, not an upstream-sync commitment.

## 🚀 Quick Start

**1. Install the CLI on your computer**

```bash
npm install -g @wangjs-jacky/paws
```

This provides the `paws` and `happy` commands (plus `paws-mcp` / `happy-mcp` for MCP integration).

**2. Open the Web App or install the mobile app**

Open the hosted [**Paws Web App**](https://47.115.228.20:8443/) in a modern browser, or download
the latest **Android APK** from [GitHub Releases](https://github.com/wangjs-jacky/happy/releases)
(arm64, sideload install).

**3. Wrap your agent and pair**

```bash
# Instead of claude / codex, run:
paws claude
# or
paws codex
```

Scan the QR code with the app to pair — from then on the session is mirrored to your phone.

**4. (Optional) Let your phone start new sessions**

```bash
paws daemon start
```

With the daemon running, the app can spawn fresh sessions on this machine remotely — no desk visit needed.

For source installs, server options, app builds and troubleshooting, read the
[Getting Started guide](docs/getting-started.md) ([中文版](docs/getting-started.zh-CN.md)).

## 🐾 Why Paws?

- 📱 **Remote control for your coding agents** — Claude Code, Codex, Gemini, OpenCode and other ACP-compatible agents
- 🔔 **Reliable push notifications** — FCM-backed Android delivery through the current Expo Push integration, including foreground alerts
- 🖼️ **Full image workflow** — attach images when creating a session, HEIC auto-normalization, fullscreen image viewer
- ⚡ **Switch devices instantly** — take over from phone or desktop with one keypress
- 🔐 **End-to-end encrypted** — the sync server only ever relays ciphertext; your code and conversations stay private
- 🏠 **Fully self-hostable** — run your own sync server (Docker, zero-config PGlite) *and* your own OTA update channel

## 🔧 How It Works

```text
Mobile / Web App
    |
    |  HTTP + WebSocket, end-to-end encrypted payloads
    v
Sync Server (self-hosted or upstream)
    |
    |  encrypted sync, machine presence, session state
    v
paws CLI / daemon on your computer
    |
    v
Claude Code / Codex / Gemini / OpenCode / ACP-compatible agents
```

The CLI wraps your agent's terminal session. Keep working locally as usual; when you pick the
session up from your phone it seamlessly switches to remote mode, and any keypress on your
keyboard takes it back.

## ✨ What Paws Adds

| Area | Paws |
|------|------|
| **Branding** | Marmot mascot, `Paws` app name, splash & mascot-linked theme |
| **CLI distribution** | Published on npm as [`@wangjs-jacky/paws`](https://www.npmjs.com/package/@wangjs-jacky/paws) with trusted-publishing CI |
| **Android push** | FCM-backed Android notifications delivered through the current Expo Push service integration; notifications also show in-foreground and open the target session |
| **Images** | Restored image upload, first-screen attachments, fullscreen viewer, HEIC normalization for vision models |
| **OTA updates** | Self-hosted OTA pipeline with `preview` / `production` channels, per-PR preview builds, and a [version browser site](https://wangjs-jacky.github.io/happy-ota-site/) to pin any historical build via QR code |
| **Extras** | Health check-in dashboard fed by your own Markdown notes, desktop screenshot capture, session attach command, and a steady stream of UX fixes |

## 📦 Project Components

| Package | What it is |
|---------|------------|
| [`packages/happy-app`](packages/happy-app) | Mobile + web client (Expo) — ships as the **Paws** app |
| [`packages/happy-cli`](packages/happy-cli) | The `paws` CLI — wraps Claude Code / Codex, daemon, MCP tools |
| [`packages/happy-server`](packages/happy-server) | Self-hostable sync server with bundled web app |
| [`packages/happy-agent`](packages/happy-agent) | CLI for controlling agents remotely (create, send, monitor) |
| [`packages/happy-wire`](packages/happy-wire) | Shared wire types & Zod schemas |

Related repositories:

- [`paws-landing`](https://github.com/wangjs-jacky/paws-landing) — the [product website](https://paws-landing-eo4.pages.dev), built with an AI-driven design → deploy pipeline
- [`happy-ota-site`](https://github.com/wangjs-jacky/happy-ota-site) — OTA version browser (scan a QR to pin a build)

## 🏠 Self-Hosting

The sync server is a single Docker container with zero-config embedded PGlite (or external
PostgreSQL). Point the CLI and app at it and the loop is closed — nothing leaves your network:

```bash
export HAPPY_SERVER_URL=http://your-server:3005
paws claude
```

See the [Getting Started guide](docs/getting-started.md), the
[Web self-hosting manual](docs/selfhost-web-deploy.md), and the
[intranet deployment manual](docs/selfhost-intranet-deploy.md) for full instructions.
The Web manual covers domain certificates, Let's Encrypt public-IP certificates,
manual updates, the deployment helper, and rollback.

## 🙏 Acknowledgements

Paws began as a fork of [**Happy**](https://github.com/slopus/happy) by the
[slopus](https://github.com/slopus) team — a brilliant piece of engineering, generously MIT-licensed.
The `happy` package on npm and the Happy apps in the App Store / Play Store belong to the original project;
Paws ships its own CLI (`@wangjs-jacky/paws`) and its own app builds.

## 📄 License

MIT — see [LICENSE](LICENSE) for details.
