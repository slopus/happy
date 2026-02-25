# slaphappy

Control AI coding agents from anywhere — your phone, Slack, or the terminal.

Free. Open source. Built on [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

> **Fork notice:** This project is a fork of [slopus/happy](https://github.com/slopus/happy) (MIT License).

## Installation

```bash
npm install -g @hiroki_3463/slaphappy
```

Or run from source:

```bash
# From the repository root
yarn cli --help
```

## Quick Start

### Claude (default)

```bash
slaphappy
```

1. Starts a Claude Code session
2. Displays a QR code to connect from your mobile device
3. Allows real-time session sharing between Claude Code and your phone

### Slack Integration

```bash
# One-time setup
slaphappy slack setup

# Start a session
slaphappy slack
```

Your Claude Code session is now controllable from a Slack thread. Reply in the thread to send input to Claude. Permission requests and questions appear as interactive buttons.

## Commands

### Main Commands

| Command | Description |
|---------|-------------|
| `slaphappy` | Start Claude Code session (default) |
| `slaphappy slack` | Start Slack-integrated Claude session |
| `slaphappy slack setup` | Interactive Slack setup wizard |
| `slaphappy slack status` | Show Slack config and connection state |
| `slaphappy gemini` | Start Gemini CLI session |
| `slaphappy codex` | Start Codex mode |
| `slaphappy acp` | Start a generic ACP-compatible agent |

### Utility Commands

| Command | Description |
|---------|-------------|
| `slaphappy auth` | Manage authentication |
| `slaphappy connect` | Store AI vendor API keys |
| `slaphappy sandbox` | Configure sandbox restrictions |
| `slaphappy notify` | Send a push notification |
| `slaphappy daemon` | Manage background service |
| `slaphappy doctor` | System diagnostics |

## Slack Integration

### Overview

The Slack integration creates a real-time bridge between Claude Code and a Slack thread. Each session gets its own thread where you can:

- **Send messages** — Reply in the thread to send input to Claude
- **Approve/deny tools** — Click buttons to approve or deny permission requests
- **Answer questions** — Select options when Claude asks via `AskUserQuestion`
- **Monitor progress** — Emoji reactions show processing state

### Emoji Reactions

| Emoji | Meaning |
|-------|---------|
| 👀 | Message received, processing started |
| ✅ | Claude responded |
| ⏳ | Processing in progress |

### Setup

#### 1. Create a Slack App

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest** → paste:

```json
{
  "display_information": {
    "name": "Claude Agent",
    "description": "Claude Code remote control via Slack threads",
    "background_color": "#1a1a2e"
  },
  "features": {
    "bot_user": {
      "display_name": "claude-agent",
      "always_online": true
    }
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
    "event_subscriptions": {
      "bot_events": ["message.channels"]
    },
    "socket_mode_enabled": true,
    "org_deploy_enabled": false,
    "token_rotation_enabled": false
  }
}
```

**Required scopes explained:**

| Scope | Purpose |
|-------|---------|
| `chat:write` | Post messages and update threads |
| `channels:history` | Read thread replies |
| `channels:read` | List and search channels |
| `channels:join` | Auto-join the configured channel |
| `reactions:write` | Add 👀/✅ reactions |
| `reactions:read` | Read existing reactions |
| `users:read` | List workspace members for owner selection |

#### 2. Get Tokens

- **Bot Token** (`xoxb-`): OAuth & Permissions → Install to Workspace → copy Bot User OAuth Token
- **App Token** (`xapp-`): Basic Information → App-Level Tokens → Generate (scope: `connections:write`)

#### 3. Run Setup Wizard

```bash
slaphappy slack setup
```

The wizard will prompt for:
1. **Bot Token** — paste your `xoxb-` token
2. **App Token** — paste your `xapp-` token
3. **Channel** — search and select from your workspace channels
4. **Notification user** — search and select a user (this user becomes the only authorized user for the session)
5. **Server URL** — optional, defaults to official server

### Usage

```bash
# Start with default permission mode
slaphappy slack

# Start with auto-approve (questions still require interaction)
slaphappy slack --permission-mode bypassPermissions

# Start with a specific model
slaphappy slack --model opus
```

In `bypassPermissions` mode, all tool calls (Bash, Edit, Write, etc.) are auto-approved. The only exception is `AskUserQuestion`, which always renders interactive buttons in Slack so you can select an answer.

### Security

- **User allowlist**: Only the user selected during setup can interact with the bot. Messages from other users are silently ignored.
- **Channel isolation**: The bot only listens in the configured channel.
- **Session-scoped threads**: Each session creates its own thread. No cross-session interference.

### Troubleshooting

| Problem | Solution |
|---------|----------|
| `missing_scope` error | Reinstall the app in Slack (OAuth & Permissions → Reinstall) |
| Bot not posting to channel | The bot auto-joins on start. If it fails, manually invite it with `/invite @claude-agent` |
| Multiple Socket Mode connections warning | Previous sessions may have stale connections. They expire automatically after ~30 seconds |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `HAPPY_SLACK_BOT_TOKEN` | Override bot token (skips config file) |
| `HAPPY_SLACK_APP_TOKEN` | Override app token |
| `HAPPY_SLACK_CHANNEL_ID` | Override channel ID |

## Options

### Claude Options

| Option | Description |
|--------|-------------|
| `-m, --model <model>` | Claude model to use (default: sonnet) |
| `-p, --permission-mode <mode>` | Permission mode: default, acceptEdits, bypassPermissions, plan |
| `--claude-env KEY=VALUE` | Set environment variable for Claude Code |
| `--claude-arg ARG` | Pass additional argument to Claude CLI |

### Global Options

| Option | Description |
|--------|-------------|
| `-h, --help` | Show help |
| `-v, --version` | Show version |
| `--no-sandbox` | Disable sandbox for the current run |

## Environment Variables

### Happy Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `HAPPY_SERVER_URL` | Custom server URL | `https://api.cluster-fluster.com` |
| `HAPPY_WEBAPP_URL` | Custom web app URL | `https://app.happy.engineering` |
| `HAPPY_HOME_DIR` | Custom home directory | `~/.happy` |
| `HAPPY_DISABLE_CAFFEINATE` | Disable macOS sleep prevention | — |
| `HAPPY_EXPERIMENTAL` | Enable experimental features | — |

### Gemini Configuration

| Variable | Description |
|----------|-------------|
| `GEMINI_MODEL` | Override default Gemini model |
| `GOOGLE_CLOUD_PROJECT` | Google Cloud Project ID (for Workspace accounts) |

## Gemini

```bash
# First-time setup
slaphappy connect gemini

# Start session
slaphappy gemini

# Model management
slaphappy gemini model set gemini-2.5-pro
slaphappy gemini model get

# Google Workspace accounts require a project
slaphappy gemini project set your-project-id
```

Available models: `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`

## Requirements

- Node.js >= 20.0.0
- Claude CLI installed & logged in (`claude` command in PATH)
- For Gemini: `npm install -g @google/gemini-cli`

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

MIT — Copyright (c) 2024 Happy Coder Contributors
