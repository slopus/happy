# Paws Getting Started

This guide is for people who want to use Paws, connect a computer, run the
daemon, or self-host the sync server. Paws is independently maintained; its
historical GitHub fork relationship does not change the installation path. It starts with the
shortest path to a working setup and then covers source installs, server
options, app builds, and troubleshooting.

It intentionally documents the public, reusable path only. Private local auth
wrappers and machine-specific infrastructure scripts do not belong in this
guide.

## What Paws Does

Paws lets you control AI coding agents from another device. You run the
`paws` CLI on a computer that has access to your code, then use the mobile or
web app to watch progress, send instructions, handle permission prompts, and
start new sessions while that computer is online.

```text
Mobile / Web App
    |
    |  HTTP + WebSocket, end-to-end encrypted payloads
    v
Paws-compatible Sync Server
    |
    |  encrypted sync, machine presence, session state
    v
paws CLI / daemon on your computer
    |
    v
Claude Code / Codex / Gemini / OpenCode / ACP-compatible agents
```

Important terms:

- **App**: the remote control UI on mobile, web, or desktop.
- **CLI**: the `paws` command you run on the machine with your project. `happy` is retained as a compatibility alias.
- **daemon**: the background process that keeps the machine available for
  remote session creation.
- **server**: the sync relay. It stores and forwards encrypted records but does
  not need plaintext access to your conversations.
- **Paws**: the product and repository described by this guide. Production builds are named `Paws`; dev and preview builds are named `Paws (dev)` and `Paws (preview)`.

## Which Path Should I Use?

| Goal | Use this path |
|------|---------------|
| Use Paws | Install the Paws APK and the public `@wangjs-jacky/paws` CLI package. |
| Run your own relay server | Start with `paws server` for a single-machine test, then use Docker for a shared server. |
| Contribute code | Create a worktree from `main`, install pnpm dependencies, and run package-specific checks. |

The CLI is published as `@wangjs-jacky/paws`. It installs `paws` as the primary command and also exposes `happy` for compatibility with existing scripts, configuration, and internal paths.

## Repository Map

This repository is a pnpm monorepo.

| Path | Package | Purpose |
|------|---------|---------|
| `packages/happy-app` | `happy-app` | Expo / React Native app for iOS, Android, web, and desktop experiments |
| `packages/happy-cli` | `@wangjs-jacky/paws` | `paws` CLI, `happy` compatibility alias, agent runners, daemon, local state, auth, and sync |
| `packages/happy-server` | `happy-server-self-host` | Fastify + Socket.IO backend for encrypted sync and self-hosting |
| `packages/paws-agent` | `@wangjs-jacky/paws-agent` | Browser-safe SDK and CLI for machines, sessions, messages, requests, and realtime events |
| `packages/happy-wire` | `@slopus/happy-wire` | Shared wire schemas and protocol types |
| `packages/happy-app-logs` | `happy-app-logs` | Development helper for app logs |
| `packages/codium` | `codium` | Desktop / experimental package |
| `environments/` | - | Local isolated environments and fixture projects |
| `docs/` | - | Architecture, protocol, deployment, and planning docs |

## User Quick Start

Use this path if you want one phone or browser to control one computer.

### 1. Download the App

Paws Android APK builds are published on GitHub Releases:

- Releases page: <https://github.com/wangjs-jacky/happy/releases>
- Latest GitHub-marked release: <https://github.com/wangjs-jacky/happy/releases/latest>

Download the `.apk` asset from the latest non-prerelease Android release and
sideload it on your Android device. On Android, allow installation from the
browser or file manager when prompted.

Notes:

- GitHub's "Latest" marker is the safest default for normal users. Specialty
  releases can be newer but may require matching server or native configuration.
- App and CLI builds must use the same `paws://` pairing scheme.
- For self-hosting, the app and CLI must point to the same server URL.

### 2. Install the Agent CLI

Paws wraps an existing coding-agent CLI. Install and sign in to the one you
want to use before starting Paws.

```bash
# Claude Code
npm install -g @anthropic-ai/claude-code
claude --version
claude

# Codex
npm install -g @openai/codex
codex --version
codex

# Gemini
npm install -g @google/gemini-cli
gemini --version
```

If the underlying agent cannot run by itself, Paws cannot fix that. Confirm
the agent is installed and authenticated first.

### 3. Install the Paws CLI

Install the public package:

```bash
npm install -g @wangjs-jacky/paws
paws --version
```

Use `paws` in new documentation and scripts. The installed `happy` command is a compatibility alias. Contributors who need to test unpublished source changes can use the source-link workflow under [Developing From Source](#developing-from-source).

### 4. Point CLI and App at the Same Server

If you use the default server built into your app/CLI, you can skip this step.
For self-hosting or team servers, set both CLI URLs:

```bash
export HAPPY_SERVER_URL=http://your-server:3005
export HAPPY_WEBAPP_URL=http://your-server:3005
```

Make it persistent by adding those exports to your shell profile, or by writing
the same values into `~/.happy/settings.json`:

```json
{
  "serverUrl": "http://your-server:3005",
  "webappUrl": "http://your-server:3005"
}
```

In the mobile app, open settings and set the custom server URL to the same
origin. The exact URL matters: `http://host:3005` and `https://host:8443` are
different servers from the client's perspective.

### 5. Pair the Computer

Pairing gives the computer access to your encrypted account key.

```bash
paws auth login --force
```

Choose the mobile-app login flow, scan the QR code with the app, and approve
the request. You can also start a session directly:

```bash
paws
paws claude
paws codex
```

Fork builds use `paws://terminal?...` terminal pairing links. If the app says
the QR code is invalid, you probably mixed an app and CLI from different
builds.

### 6. Start a Test Session

Start from the computer:

```bash
paws codex
# or
paws
```

Then verify the app can see the session, send a message, and receive updates.
After that, start one session from the app to confirm remote spawning works.

## Daemon

The daemon lets the app create sessions while the computer is online and no
terminal session is open.

```bash
paws daemon start
paws daemon status
paws daemon list
paws daemon logs
paws daemon stop
```

The daemon inherits environment variables from the shell that starts it. If you
change `HAPPY_SERVER_URL`, `HAPPY_WEBAPP_URL`, `PATH`, proxy variables, or agent
credentials, restart the daemon from a shell that has the correct environment:

```bash
paws daemon stop
paws daemon start
paws daemon status
```

Useful local state:

| Path | Contents |
|------|----------|
| `~/.happy/settings.json` | Server URL, web app URL, onboarding, and profile settings |
| `~/.happy/access.key` | Local key material |
| `~/.happy/daemon.state.json` | Daemon PID, control port, and version |
| `~/.happy/sessions.json` | Local session index |
| `~/.happy/logs/` | CLI and daemon logs |
| `~/.happy/attachments/` | Original attachment bytes staged for agent use |

Set `HAPPY_HOME_DIR` when you need a separate profile:

```bash
HAPPY_HOME_DIR=~/.happy-dev paws codex
```

If daemon state is badly stuck during local development, use:

```bash
paws doctor clean
```

That kills Paws-related daemon/session processes, so do not run it if you need
to preserve active local sessions.

## Server Options

You can either use an existing Happy-compatible server or run your own.

The CLI resolves URLs in this order:

```text
HAPPY_SERVER_URL / HAPPY_WEBAPP_URL env vars
> ~/.happy/settings.json
> built-in defaults
```

The app resolves its server URL in this order:

```text
In-app custom server setting
> window.__HAPPY_CONFIG__.serverUrl
> EXPO_PUBLIC_HAPPY_SERVER_URL
> built-in default
```

For team or production usage, prefer HTTPS. Plain HTTP is convenient for local
development and private LAN tests, but mobile platforms may block it unless the
app build explicitly allows that network policy.

## Self-Hosting

Use self-hosting when you want control over the sync server and storage.

### Option A: Single-Machine `paws server`

This is the fastest way to test a local server. It uses embedded PGlite storage
under `~/.happy/server-data/`.

```bash
npm install -g happy-server-self-host
paws server
```

By default, `paws server` asks before writing `serverUrl` and `webappUrl` into
`~/.happy/settings.json`. Use `--no-persist` to start the server without
modifying CLI settings:

```bash
paws server --no-persist
```

To make the server reachable from other devices on your LAN:

```bash
paws server --host 0.0.0.0
```

Then point the app and CLI at `http://<your-computer-lan-ip>:3005`.

### Option B: Docker Standalone

Use Docker for a shared server or repeatable deployment. From the repository
root:

```bash
docker build -f Dockerfile -t happy-server:local .
```

Generate a master secret:

```bash
openssl rand -hex 32
```

Create `docker-compose.yml`:

```yaml
services:
  happy-server:
    image: happy-server:local
    container_name: happy-server
    restart: unless-stopped
    ports:
      - "3005:3005"
    volumes:
      - ./data:/data
    environment:
      NODE_ENV: production
      PORT: "3005"
      HOST: "0.0.0.0"
      HANDY_MASTER_SECRET: "replace-with-a-random-secret"
```

Start it:

```bash
docker compose up -d
docker compose logs -f happy-server
```

Verify:

```bash
curl -i http://localhost:3005/health
```

Point the CLI at it:

```bash
export HAPPY_SERVER_URL=http://localhost:3005
export HAPPY_WEBAPP_URL=http://localhost:3005
paws auth login --force
```

For LAN or team usage, replace `localhost` with a stable host name or IP that
both the phone and computer can reach.

### Option C: Source Standalone

For development or local experiments:

```bash
pnpm install
pnpm --filter happy-server-self-host standalone:dev
```

This starts the server on port `3005` with embedded PGlite storage.

### Server Environment Variables

Minimum standalone configuration:

| Variable | Required | Description |
|----------|----------|-------------|
| `HANDY_MASTER_SECRET` | Yes | Master secret for server-side auth tokens and encrypted service tokens |
| `PORT` | No | Server port, default `3005` |
| `HOST` | No | Bind address, default `0.0.0.0` |
| `DATA_DIR` | No | Base data directory |
| `PGLITE_DIR` | No | Embedded database directory |
| `PUBLIC_URL` | No | Public base URL used for generated file URLs |

Optional production services:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Use external PostgreSQL instead of PGlite |
| `REDIS_URL` | Redis-backed multi-process Socket.IO behavior |
| `S3_HOST`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_PUBLIC_URL` | S3-compatible blob storage |
| `ELEVENLABS_API_KEY`, `REVENUECAT_API_KEY` | Voice and paid feature integrations |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, related GitHub variables | GitHub OAuth / integration support |

Keep `HANDY_MASTER_SECRET` stable after launch. Rotating it invalidates issued
server auth tokens and server-encrypted integration tokens.

## Developing From Source

### Prerequisites

```bash
node --version   # Node.js 20+
corepack enable
pnpm --version
git --version
```

Install dependencies:

```bash
git clone https://github.com/wangjs-jacky/happy.git
cd happy
git switch main
pnpm install
```

To make the current source checkout your global development CLI:

```bash
pnpm --filter @wangjs-jacky/paws build
cd packages/happy-cli
npm link
paws --version
```

### Static Checks

App:

```bash
pnpm --filter happy-app typecheck
pnpm --filter happy-app test
```

CLI:

```bash
pnpm --filter @wangjs-jacky/paws typecheck
pnpm --filter @wangjs-jacky/paws test
pnpm --filter @wangjs-jacky/paws build
```

Server:

```bash
pnpm --filter happy-server-self-host typecheck
pnpm --filter happy-server-self-host test
pnpm --filter happy-server-self-host build
```

Agent and wire package:

```bash
pnpm --filter @wangjs-jacky/paws-agent typecheck
pnpm --filter @slopus/happy-wire typecheck
```

### Local Environment Manager

The `environments/` tool creates isolated local setups with separate Happy
state, server URL, web URL, ports, and fixture projects:

```bash
pnpm env:new
pnpm env:use <name>
pnpm env:up
pnpm env:server
pnpm env:web
pnpm env:cli --help
pnpm env:cli codex
```

This is useful when you need to test without touching your real `~/.happy`
state.

## App Builds and OTA Updates

Current app metadata is defined in `packages/happy-app/app.config.js`:

| Field | Value |
|-------|-------|
| Slug | `paws` |
| App version | `1.7.1` |
| Production app name | `Paws` |
| Preview app name | `Paws (preview)` |
| Development app name | `Paws (dev)` |
| Production package / bundle ID | `build.paws` |
| Preview package / bundle ID | `build.paws.preview` |
| Development package / bundle ID | `build.paws.dev` |

Runtime and channel mapping:

| `APP_ENV` | OTA channel | Runtime version |
|-----------|-------------|-----------------|
| `development` | `preview` | `22` |
| `preview` | `preview` | `22` |
| `production` | `production` | `23` |

Only JavaScript-compatible changes should be delivered by OTA. Native
dependencies, permissions, Expo plugins, package IDs, update URLs, and runtime
version changes require a new app build. Automatic preview and production OTA
workflows skip diffs that touch native-sensitive configuration; publish that
runtime manually only after installing its matching binary.

## Troubleshooting

### The App Does Not Show My Machine Online

Check that the app and computer use the same server:

```bash
paws daemon status
cat ~/.happy/settings.json
echo "$HAPPY_SERVER_URL"
echo "$HAPPY_WEBAPP_URL"
```

Then inspect daemon logs:

```bash
LOG=$(ls -t ~/.happy/logs/*-daemon.log | head -1)
sed -n '1,80p' "$LOG"
```

Common causes:

- The daemon is not running.
- The computer and app point to different servers.
- A self-hosted server is unreachable from the phone.
- The agent CLI is not installed or not authenticated.
- The daemon was started before your current environment variables were set.

### QR Code Is Invalid or Pairing Does Nothing

Check:

- App and CLI are from matching builds.
- Both sides point to the same server.
- Fork builds expect `paws://terminal?...` terminal pairing links.
- Paws builds expect the `paws://` app scheme.

### Auth Opens the Wrong Web App

Set both URLs:

```bash
export HAPPY_SERVER_URL=http://your-server:3005
export HAPPY_WEBAPP_URL=http://your-server:3005
```

If only `HAPPY_SERVER_URL` is set, the CLI may contact your self-hosted API but
open a different web app for auth.

### Remote Session Creation Fails

Look for daemon spawn errors:

```bash
LOG=$(ls -t ~/.happy/logs/*-daemon.log | head -1)
rg -n "spawn|Child PID|exited|timeout|Session started|Session reported" "$LOG"
```

Common causes:

- The requested working directory does not exist.
- The target agent command is unavailable on `PATH`.
- The agent is not logged in.
- Proxy or network settings differ between your shell and the daemon process.
- The daemon inherited an older `PATH` or Node runtime than your current shell.

### CLI Package Looks Too Old

```bash
npm view @wangjs-jacky/paws version
npm install -g @wangjs-jacky/paws@latest
paws --version
```

### Push Notifications Do Not Arrive

Remote control uses WebSocket sync; push notifications are a convenience layer.
If push fails, foreground app usage and manual refresh may still work.

Check:

- Mobile notification permission.
- Whether the server can reach the push provider.
- Whether the app is installed as a build that includes push configuration.

### Attachments Fail in Agent Sessions

If using S3-compatible storage, verify:

- `S3_HOST`
- `S3_BUCKET`
- `S3_PUBLIC_URL`
- `S3_PATH_STYLE`
- Whether presigned upload/download URLs are reachable from the CLI machine.

Local-storage standalone mode writes blobs under the configured data directory.

## Recommended Reading

Read these next:

1. `README.md` for the product overview.
2. `docs/README.md` for the documentation index.
3. `docs/cli-architecture.md` for CLI, daemon, local state, and agent runners.
4. `docs/backend-architecture.md` for server internals.
5. `docs/api.md` for HTTP endpoints and authentication.
6. `docs/encryption.md` for encryption boundaries.
7. `docs/session-protocol.md` for encrypted chat event flow.
8. `docs/selfhost-intranet-deploy.md` for a deeper self-hosting walkthrough.

## Handoff Checklist

Before giving this setup to another user or teammate:

- [ ] They installed the Paws App and `@wangjs-jacky/paws` CLI from compatible releases.
- [ ] They know which server they should use.
- [ ] Their phone or browser can reach that server.
- [ ] Their app and CLI use matching pairing schemes.
- [ ] Their `paws` CLI is installed.
- [ ] Their target agent CLI is installed and authenticated.
- [ ] `paws daemon status` reports a healthy daemon.
- [ ] The app can authenticate and see the machine online.
- [ ] A test session can be started from the computer.
- [ ] A test session can be started from the app.
- [ ] Self-hosted setups set both `HAPPY_SERVER_URL` and `HAPPY_WEBAPP_URL`.
- [ ] Team or production setups use HTTPS or an explicitly accepted LAN policy.
