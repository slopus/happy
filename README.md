<div align="center"><img src="/.github/logotype-dark.png" width="400" title="Happy Coder" alt="Happy Coder"/></div>

<h1 align="center">
  slaphappy — Mobile and Web Client for Claude Code & Codex
</h1>

<h4 align="center">
Use Claude Code or Codex from anywhere with end-to-end encryption.
</h4>

> **This is a fork of [slopus/happy](https://github.com/slopus/happy) (MIT License).**
> CLI is published as [`@hiroki_3463/slaphappy`](https://www.npmjs.com/package/@hiroki_3463/slaphappy) with the command name `slaphappy`.

<div align="center">

[📱 **iOS App**](https://apps.apple.com/us/app/happy-claude-code-client/id6748571505) • [🤖 **Android App**](https://play.google.com/store/apps/details?id=com.ex3ndr.happy) • [🌐 **Web App**](https://app.happy.engineering) • [🎥 **See a Demo**](https://youtu.be/GCS0OG9QMSE) • [📚 **Documentation**](https://happy.engineering/docs/) • [💬 **Discord**](https://discord.gg/fX9WBAhyfD)

</div>

<img width="5178" height="2364" alt="github" src="/.github/header.png" />


<h3 align="center">
Step 1: Download App
</h3>

<div align="center">
<a href="https://apps.apple.com/us/app/happy-claude-code-client/id6748571505"><img width="135" height="39" alt="appstore" src="https://github.com/user-attachments/assets/45e31a11-cf6b-40a2-a083-6dc8d1f01291" /></a>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<a href="https://play.google.com/store/apps/details?id=com.ex3ndr.happy"><img width="135" height="39" alt="googleplay" src="https://github.com/user-attachments/assets/acbba639-858f-4c74-85c7-92a4096efbf5" /></a>
</div>

<h3 align="center">
Step 2: Install CLI on your computer
</h3>

```bash
npm install -g @hiroki_3463/slaphappy
```

**Or install from source:**

```bash
git clone https://github.com/HirokiKobayashi-R/happy.git
cd happy
yarn install
cd packages/happy-cli
yarn build
npm link
```

<h3 align="center">
Run From Source (Repo Checkout)
</h3>

```bash
# from repository root
yarn cli --help
yarn cli codex
```

<h3 align="center">
Release (Maintainers)
</h3>

```bash
# from repository root
yarn release
```

<h3 align="center">
Step 3: Start using <code>slaphappy</code> instead of <code>claude</code> or <code>codex</code>
</h3>

```bash

# Instead of: claude
# Use: slaphappy

slaphappy

# Instead of: codex
# Use: slaphappy codex

slaphappy codex

```

<div align="center"><img src="/.github/mascot.png" width="200" title="Happy Coder" alt="Happy Coder"/></div>

## How does it work?

On your computer, run `slaphappy` instead of `claude` or `slaphappy codex` instead of `codex` to start your AI through our wrapper. When you want to control your coding agent from your phone, it restarts the session in remote mode. To switch back to your computer, just press any key on your keyboard.

## 💬 Slack Integration (Fork Exclusive)

Control Claude Code directly from a Slack channel. Each CLI session creates a dedicated thread — reply in the thread to send input, and Claude's output appears in real time. No public endpoints required (Socket Mode).

### How It Works

```
slaphappy slack
    ↓
Slack channel: header message posted (🟢 Session active)
    ↓
┌─── Slack Thread ─────────────────────────────────────────┐
│ 🟢 Session: my-project | claude-opus-4-6                 │
│ Session ID: a1b2c3d4   Turns: 0  Cost: $0.00             │
│                                                           │
│ ⚡ Session started. Reply here to send input to Claude.   │
│                                                           │
│ You:    "list all TypeScript files"                 👀    │
│ ⏳ Processing…                                            │
│ Claude: "Found 42 .ts files: ..."                  ✅    │
│                                                           │
│ 🔒 Permission Request: Bash(rm -rf dist/)                 │
│ [Approve] [Deny]                          ← Block Kit     │
│                                                           │
│ You:    "now run the tests"                               │
│ Claude: "All 450 tests passed."                           │
└───────────────────────────────────────────────────────────┘
    ↓
Session ends → header updates to ✅ Completed
```

- **1 session = 1 thread** — `slaphappy slack` posts a header message; all I/O happens in that thread
- **Bidirectional** — Slack replies → Claude input, Claude output → thread posts
- **Permission requests** — tool calls appear as Approve / Deny buttons (Block Kit interactive messages)
- **AskUserQuestion** — Claude's multiple-choice questions render as clickable buttons
- **Reactions** — 👀 on your message when received, ✅ when Claude finishes responding
- **Processing indicator** — ⏳ "Processing..." message shown while Claude is thinking (auto-deleted on completion)
- **Header live-updates** — turn count, cost, and status (🟢 active / ✅ completed / ❌ error) update in real time
- **Socket Mode** — uses WebSocket via Slack's Socket Mode; no public URL or ngrok needed
- **Singleton connection** — multiple concurrent sessions share one Socket Mode connection, routed by `thread_ts`

---

### Quick Start

```bash
# 1. Run the interactive setup wizard
slaphappy slack setup

# 2. Start a Slack-connected Claude session
slaphappy slack

# 3. Reply in the Slack thread to interact with Claude
```

---

### Setup Wizard (Step by Step)

`slaphappy slack setup` guides you through the full setup interactively:

#### Step 1: Create a Slack App

Go to [api.slack.com/apps](https://api.slack.com/apps) → **"Create New App"** → **"From a manifest"** → select your workspace → paste the manifest below → **Create**.

The wizard prints this manifest for you, but here it is for reference:

```json
{
  "display_information": {
    "name": "Claude Agent",
    "description": "Claude Code remote control via Slack threads",
    "background_color": "#1a1a2e"
  },
  "features": {
    "bot_user": { "display_name": "claude-agent", "always_online": true }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "channels:history",
        "channels:read",
        "channels:join",
        "reactions:write",
        "reactions:read",
        "users:read"
      ]
    }
  },
  "settings": {
    "event_subscriptions": { "bot_events": ["message.channels"] },
    "socket_mode_enabled": true,
    "org_deploy_enabled": false,
    "token_rotation_enabled": false
  }
}
```

#### Step 2: Install & Get Bot Token

In your app settings → **"OAuth & Permissions"** → **"Install to Workspace"** → copy the **Bot User OAuth Token** (starts with `xoxb-`).

#### Step 3: Generate App-Level Token

**"Basic Information"** → **"App-Level Tokens"** → **"Generate Token"** → name it `socket`, add scope `connections:write` → copy the token (starts with `xapp-`).

#### Step 4: Enter Tokens

The wizard prompts for the two tokens and validates them against the Slack API (`auth.test`).

#### Step 5: Select a Channel

The wizard fetches all public channels in your workspace (with search). The bot auto-joins the selected channel. If `channels:join` scope is missing, you can `/invite @claude-agent` manually.

#### Step 6: Select Session Owner (Required)

Select yourself from the workspace member list. This user is the **only one** who can send commands and click permission buttons in the session thread. You'll also be @mentioned when the session starts.

#### Step 7: Server URL (Optional)

Custom Happy Server URL (default: `https://api.cluster-fluster.com`). Only needed for self-hosted setups.

Config is saved to `~/.happy/slack.json` with file permissions `0600`. Re-running `slaphappy slack setup` shows current values as defaults — press Enter to keep them.

---

### CLI Commands

| Command | Description |
|---------|-------------|
| `slaphappy slack setup` | Interactive setup wizard (create app, enter tokens, pick channel) |
| `slaphappy slack status` | Show current config with masked tokens and env override status |
| `slaphappy slack` | Start a Slack-connected Claude session |
| `slaphappy slack --help` | Show all Slack options |

### CLI Options for `slaphappy slack`

| Option | Description | Example |
|--------|-------------|---------|
| `--model`, `-m` | Claude model to use | `slaphappy slack -m claude-sonnet-4-6` |
| `--permission-mode` | Permission handling mode | `slaphappy slack --permission-mode acceptEdits` |
| `--started-by` | How the session was started | `slaphappy slack --started-by daemon` |
| `--js-runtime` | JavaScript runtime (`node` or `bun`) | `slaphappy slack --js-runtime bun` |

Any additional flags are passed through to Claude as `claudeArgs`.

### Permission Modes

| Mode | Behavior in Slack |
|------|-------------------|
| `default` | Tool calls post Approve/Deny buttons in thread; waits for user click |
| `acceptEdits` | File edits auto-approved; destructive operations still require approval |
| `bypassPermissions` | All tool calls auto-approved (no buttons posted) |
| `plan` | Claude operates in plan-only mode |

---

### Environment Variables

All config values can be set via environment variables. These **override** `~/.happy/slack.json` when present, enabling headless / CI usage without the setup wizard.

| Variable | Required | Description |
|----------|----------|-------------|
| `HAPPY_SLACK_BOT_TOKEN` | Yes | Slack Bot User OAuth Token (`xoxb-...`) |
| `HAPPY_SLACK_APP_TOKEN` | Yes | Slack App-Level Token with `connections:write` (`xapp-...`) |
| `HAPPY_SLACK_CHANNEL_ID` | Yes | Channel ID to post session threads (`C0123456789`) |
| `HAPPY_SLACK_AUTHORIZED_USER_ID` | **Yes** | Your Slack user ID (`U987654321`). Session owner for access control. |

> **`HAPPY_SLACK_AUTHORIZED_USER_ID` serves dual purposes:** (1) @mentions you when a session starts, and (2) **restricts session access to only that user**. Thread replies and button clicks from anyone else are silently ignored.

If all three required variables are set, `slaphappy slack` works without `~/.happy/slack.json`.

```bash
# Example: headless CI usage
export HAPPY_SLACK_BOT_TOKEN=xoxb-1234-5678-abcdef
export HAPPY_SLACK_APP_TOKEN=xapp-1-A0123-9876-xyz
export HAPPY_SLACK_CHANNEL_ID=C0123456789
export HAPPY_SLACK_AUTHORIZED_USER_ID=U987654321  # restricts access to this user only

slaphappy slack --permission-mode bypassPermissions
```

`slaphappy slack status` shows which env overrides are active.

---

### Required Slack App Scopes

| Type | Scope | Purpose |
|------|-------|---------|
| **Bot** | `chat:write` | Post messages and buttons to threads |
| **Bot** | `channels:history` | Read thread replies (incoming user messages) |
| **Bot** | `channels:read` | List channels during setup |
| **Bot** | `channels:join` | Auto-join the selected channel |
| **Bot** | `reactions:write` | Add 👀 / ✅ reactions to messages |
| **Bot** | `reactions:read` | Read reactions |
| **Bot** | `users:read` | List workspace members during setup |
| **App-Level** | `connections:write` | Socket Mode WebSocket connection |

**Event subscription:** `message.channels` (receives messages posted in public channels).

---

### Config File

`~/.happy/slack.json` (created by `slaphappy slack setup`):

```json
{
  "botToken": "xoxb-...",
  "appToken": "xapp-...",
  "channelId": "C0123456789",
  "channelName": "claude-sessions",
  "authorizedUserId": "U987654321",
  "serverUrl": "https://api.cluster-fluster.com",
  "defaultPermissionMode": "default"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `botToken` | string | Yes | Bot User OAuth Token (`xoxb-...`) |
| `appToken` | string | Yes | App-Level Token (`xapp-...`) |
| `channelId` | string | Yes | Slack channel ID |
| `channelName` | string | No | Channel display name (auto-populated) |
| `authorizedUserId` | string | **Yes** | Your Slack user ID — @mentions on start **and restricts access to this user only** |
| `serverUrl` | string | No | Happy Server URL override |
| `defaultPermissionMode` | enum | No | `default` \| `acceptEdits` \| `bypassPermissions` \| `plan` |

---

### Security Considerations

- **`authorizedUserId` is mandatory.** Only the specified user's messages and button clicks are accepted; all others are silently dropped.
- **Channel access matters.** Others can still *read* Claude's output even though they can't control it. Use a private or restricted channel for sensitive work.
- **Permission mode matters.** `bypassPermissions` means any thread reply triggers tool execution without confirmation. Use with caution.
- **Tokens are stored locally** in `~/.happy/slack.json` with `0600` permissions. They never leave your machine.
- **Socket Mode** means no inbound webhooks — your machine initiates the WebSocket connection outbound. No public endpoint exposure.

## 🔥 Why Happy Coder?

- 📱 **Mobile access to Claude Code and Codex** - Check what your AI is building while away from your desk
- 🔔 **Push notifications** - Get alerted when Claude Code and Codex needs permission or encounters errors
- 💬 **Slack integration** - Control Claude Code from a Slack thread (fork exclusive)
- ⚡ **Switch devices instantly** - Take control from phone or desktop with one keypress
- 🔐 **End-to-end encrypted** - Your code never leaves your devices unencrypted
- 🛠️ **Open source** - Audit the code yourself. No telemetry, no tracking

## 📦 Project Components

- **[Happy App](https://github.com/slopus/happy/tree/main/packages/happy-app)** - Web UI + mobile client (Expo)
- **[Happy CLI](https://github.com/slopus/happy/tree/main/packages/happy-cli)** - Command-line interface for Claude Code and Codex
- **[Happy Agent](https://github.com/slopus/happy/tree/main/packages/happy-agent)** - Remote agent control CLI (create, send, monitor sessions)
- **[Happy Server](https://github.com/slopus/happy/tree/main/packages/happy-server)** - Backend server for encrypted sync

## 🏠 Who We Are

We're engineers scattered across Bay Area coffee shops and hacker houses, constantly checking how our AI coding agents are progressing on our pet projects during lunch breaks. Happy Coder was born from the frustration of not being able to peek at our AI coding tools building our side hustles while we're away from our keyboards. We believe the best tools come from scratching your own itch and sharing with the community.

## 🖥️ Self-Hosting the Server

**You don't need to self-host!** Our free cloud Happy Server at `happy-api.slopus.com` is just as secure as running your own. Since all data is end-to-end encrypted before it reaches our servers, we literally cannot read your messages even if we wanted to. The encryption happens on your device, and only you have the keys.

That said, Happy Server is open source and self-hostable if you prefer running your own infrastructure. The security model is identical whether you use our servers or your own.

```bash
git clone https://github.com/HirokiKobayashi-R/happy.git
cd happy/packages/happy-server/deploy
cp .env.example .env   # Edit with your values
docker compose up -d
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `API_DOMAIN` | API domain (e.g., `happy-api.example.com`) |
| `S3_DOMAIN` | Files domain (e.g., `happy-files.example.com`) |
| `S3_PUBLIC_URL` | Public file URL (e.g., `https://happy-files.example.com/happy`) |
| `HANDY_MASTER_SECRET` | Token signing secret (`openssl rand -hex 32`) |
| `POSTGRES_PASSWORD` | PostgreSQL password |
| `S3_ACCESS_KEY` | MinIO access key |
| `S3_SECRET_KEY` | MinIO secret key |

### Connecting Clients to Your Server

- **CLI:** `HAPPY_SERVER_URL=https://happy-api.example.com slaphappy`
- **Mobile:** Tap server icon on login screen to change server

## 📱 Building the Mobile App

**Prerequisites:**
- For iOS: Xcode, Apple Developer account
- For Android: Android Studio with SDK

**Build and install:**

```bash
cd packages/happy-app
yarn install
yarn prebuild

# iOS
yarn ios:dev                # Simulator
yarn ios:connected-device   # Physical device via USB

# Android
yarn android:dev            # Emulator or connected device
```

**Android Wireless Debugging:**

```bash
# On your phone: Settings > Developer options > Wireless debugging > Pair device
adb pair <IP>:<PAIRING_PORT> <PAIRING_CODE>
adb connect <IP>:<CONNECTION_PORT>
yarn android:dev
```

**Build Variants:**

| Command | App Name | Use Case |
|---------|----------|----------|
| `yarn ios:dev` / `yarn android:dev` | Happy (dev) | Local development |
| `yarn ios:preview` / `yarn android:preview` | Happy (preview) | Beta testing |
| `yarn ios:production` / `yarn android:production` | Happy | Production |

## 📚 Documentation & Contributing

- **[Upstream Documentation](https://happy.engineering/docs/)** - Learn how to use Happy Coder effectively
- **[CONTRIBUTING.md](CONTRIBUTING.md)** - Development setup including iOS, Android, and macOS desktop variant builds

## License

MIT License - see [LICENSE](LICENSE) for details.

Original work Copyright (c) 2024 Happy Coder Contributors.
