# Arc CLI

Code on the go — control AI coding agents from your mobile device.

Part of [Runline](https://runline.ai). Open source. Code anywhere.

## Installation

Arc is distributed via GitHub Packages. You'll need to authenticate with GitHub first.

### Using GitHub CLI (Recommended)

```bash
# Login to GitHub Packages via gh CLI
gh auth login
gh auth refresh -s read:packages

# Configure npm to use your gh token for @runline packages
echo "@runline-ai:registry=https://npm.pkg.github.com" >> ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=$(gh auth token)" >> ~/.npmrc

# Install Arc globally
npm install -g @runline-ai/arc
```

### Manual Setup

1. Create a GitHub Personal Access Token with `read:packages` scope
2. Add to your `~/.npmrc`:

```
@runline-ai:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

3. Install:

```bash
npm install -g @runline-ai/arc
```

### Development Install (from source)

```bash
git clone https://github.com/runline-ai/arc.git
cd arc/cli
yarn install
yarn build
npm link
```

## Usage

### Claude (default)

```bash
arc
```

This will:
1. Start a Claude Code session
2. Display a QR code to connect from your mobile device
3. Allow real-time session sharing between Claude Code and your mobile app

### Gemini

```bash
arc gemini
```

Start a Gemini CLI session with remote control capabilities.

**First time setup:**
```bash
# Authenticate with Google
arc connect gemini
```

## Commands

### Main Commands

- `arc` – Start Claude Code session (default)
- `arc gemini` – Start Gemini CLI session
- `arc codex` – Start Codex mode

### Utility Commands

- `arc auth` – Manage authentication
- `arc connect` – Store AI vendor API keys
- `arc notify` – Send a push notification to your devices
- `arc daemon` – Manage background service
- `arc doctor` – System diagnostics & troubleshooting

### Connect Subcommands

```bash
arc connect gemini     # Authenticate with Google for Gemini
arc connect claude     # Authenticate with Anthropic
arc connect codex      # Authenticate with OpenAI
arc connect status     # Show connection status for all vendors
```

### Gemini Subcommands

```bash
arc gemini                      # Start Gemini session
arc gemini model set <model>    # Set default model
arc gemini model get            # Show current model
arc gemini project set <id>     # Set Google Cloud Project ID (for Workspace accounts)
arc gemini project get          # Show current Google Cloud Project ID
```

**Available models:** `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`

## Options

### Claude Options

- `-m, --model <model>` - Claude model to use (default: sonnet)
- `-p, --permission-mode <mode>` - Permission mode: auto, default, or plan
- `--claude-env KEY=VALUE` - Set environment variable for Claude Code
- `--claude-arg ARG` - Pass additional argument to Claude CLI

### Global Options

- `-h, --help` - Show help
- `-v, --version` - Show version

## Environment Variables

### Arc Configuration

- `ARC_SERVER_URL` - Custom server URL (default: https://api.cluster-fluster.com)
- `ARC_WEBAPP_URL` - Custom web app URL (default: https://app.runline.ai)
- `ARC_HOME_DIR` - Custom home directory for Arc data (default: ~/.arc)
- `ARC_DISABLE_CAFFEINATE` - Disable macOS sleep prevention (set to `true`, `1`, or `yes`)
- `ARC_EXPERIMENTAL` - Enable experimental features (set to `true`, `1`, or `yes`)

### Gemini Configuration

- `GEMINI_MODEL` - Override default Gemini model
- `GOOGLE_CLOUD_PROJECT` - Google Cloud Project ID (required for Workspace accounts)

## Gemini Authentication

### Personal Google Account

Personal Gmail accounts work out of the box:

```bash
arc connect gemini
arc gemini
```

### Google Workspace Account

Google Workspace (organization) accounts require a Google Cloud Project:

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the Gemini API
3. Set the project ID:

```bash
arc gemini project set your-project-id
```

Or use environment variable:
```bash
GOOGLE_CLOUD_PROJECT=your-project-id arc gemini
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
- Google account authenticated via `arc connect gemini`

## License

Apache-2.0
