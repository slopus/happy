# Happy

Code on the go — control AI coding agents from your mobile device.

Free. Open source. Code anywhere.

## Installation

```bash
npm install -g happy-coder
```

## Run From Source

From a repo checkout:

```bash
# repository root
yarn cli --help

# package directory
yarn cli --help
```

## Usage

### Claude (default)

```bash
happy
```

This will:
1. Start a Claude Code session
2. Display a QR code to connect from your mobile device
3. Allow real-time session sharing between Claude Code and your mobile app

### Gemini

```bash
happy gemini
```

Start a Gemini CLI session with remote control capabilities.

**First time setup:**
```bash
# Authenticate with Google
happy connect gemini
```

## Commands

### Main Commands

- `happy` – Start Claude Code session (default)
- `happy gemini` – Start Gemini CLI session
- `happy codex` – Start Codex mode

### Utility Commands

- `happy auth` – Manage authentication
- `happy connect` – Store AI vendor API keys in Happy cloud
- `happy sandbox` – Configure sandbox runtime restrictions
- `happy notify` – Send a push notification to your devices
- `happy daemon` – Manage background service
- `happy doctor` – System diagnostics & troubleshooting

### Connect Subcommands

```bash
happy connect gemini     # Authenticate with Google for Gemini
happy connect claude     # Authenticate with Anthropic
happy connect codex      # Authenticate with OpenAI
happy connect status     # Show connection status for all vendors
```

### Gemini Subcommands

```bash
happy gemini                      # Start Gemini session
happy gemini model set <model>    # Set default model
happy gemini model get            # Show current model
happy gemini project set <id>     # Set Google Cloud Project ID (for Workspace accounts)
happy gemini project get          # Show current Google Cloud Project ID
```

**Available models:** `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`

### Sandbox Subcommands

```bash
happy sandbox configure  # Interactive sandbox setup wizard
happy sandbox status     # Show current sandbox configuration
happy sandbox disable    # Disable sandboxing
```

## Options

### Claude Options

- `-m, --model <model>` - Claude model to use (default: sonnet)
- `-p, --permission-mode <mode>` - Permission mode: auto, default, or plan
- `--claude-env KEY=VALUE` - Set environment variable for Claude Code
- `--claude-arg ARG` - Pass additional argument to Claude CLI

### Global Options

- `-h, --help` - Show help
- `-v, --version` - Show version
- `--no-sandbox` - Disable sandbox for the current Claude/Codex run

## Environment Variables

### Happy Configuration

- `HAPPY_SERVER_URL` - Custom server URL (default: https://api.cluster-fluster.com)
- `HAPPY_WEBAPP_URL` - Custom web app URL (default: https://app.happy.engineering)
- `HAPPY_HOME_DIR` - Custom home directory for Happy data (default: ~/.happy)
- `HAPPY_DISABLE_CAFFEINATE` - Disable macOS sleep prevention (set to `true`, `1`, or `yes`)
- `HAPPY_EXPERIMENTAL` - Enable experimental features (set to `true`, `1`, or `yes`)

### Gemini Configuration

- `GEMINI_MODEL` - Override default Gemini model
- `GOOGLE_CLOUD_PROJECT` - Google Cloud Project ID (required for Workspace accounts)

## Gemini Authentication

### Personal Google Account

Personal Gmail accounts work out of the box:

```bash
happy connect gemini
happy gemini
```

### Google Workspace Account

Google Workspace (organization) accounts require a Google Cloud Project:

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the Gemini API
3. Set the project ID:

```bash
happy gemini project set your-project-id
```

Or use environment variable:
```bash
GOOGLE_CLOUD_PROJECT=your-project-id happy gemini
```

**Guide:** https://goo.gle/gemini-cli-auth-docs#workspace-gca

## Contributing

Interested in contributing? See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Requirements

- Node.js >= 20.0.0

### For Claude

- Claude CLI installed & logged in (`claude` command available in PATH)

### For Gemini

- Gemini CLI installed (`npm install -g @google/gemini-cli`)
- Google account authenticated via `happy connect gemini`

## License

MIT
