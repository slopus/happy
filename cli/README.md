# Happy

Code on the go controlling claude code from your mobile device.

Free. Open source. Code anywhere.

## Installation

```bash
npm install -g happy-coder
```

## Usage

```bash
happy
```

This will:
1. Start a Claude Code session
2. Display a QR code to connect from your mobile device
3. Allow real-time session sharing between Claude Code and your mobile app

## Commands

- `happy auth` – Manage authentication
- `happy codex` – Start Codex mode
- `happy connect` – Store AI vendor API keys in Happy cloud
- `happy notify` – Send a push notification to your devices
- `happy daemon` – Manage background service
- `happy doctor` – System diagnostics & troubleshooting

## Options

- `-h, --help` - Show help
- `-v, --version` - Show version
- `-m, --model <model>` - Claude model to use (default: sonnet)
- `-p, --permission-mode <mode>` - Permission mode: auto, default, or plan
- `--claude-env KEY=VALUE` - Set environment variable for Claude Code
- `--claude-arg ARG` - Pass additional argument to Claude CLI

## Environment Variables

- `HAPPY_SERVER_URL` - Custom server URL (default: https://api.cluster-fluster.com)
- `HAPPY_WEBAPP_URL` - Custom web app URL (default: https://app.happy.engineering)
- `HAPPY_HOME_DIR` - Custom home directory for Happy data (default: ~/.happy)
- `HAPPY_DISABLE_CAFFEINATE` - Disable macOS sleep prevention (set to `true`, `1`, or `yes`)
- `HAPPY_EXPERIMENTAL` - Enable experimental features (set to `true`, `1`, or `yes`)

## Contributing

Interested in contributing? See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup instructions.

## Development

For developers who want to contribute or test the latest features.

### Prerequisites

- Node.js >= 20.0.0
- [Yarn](https://yarnpkg.com/) package manager
- Git
- Claude CLI installed (`claude` command available in PATH)

### Quick Start

```bash
git clone https://github.com/slopus/happy-cli.git
cd happy-cli
yarn install
yarn build
yarn link:dev   # Creates happy-dev command
```

The `happy-dev` command is for development only and is not included in the npm package.

### Development Workflow

```bash
yarn build      # Rebuild after code changes
happy-dev       # Test with isolated ~/.happy-dev/ data directory
```

### Linking Commands

| Command | What it does |
|---------|--------------|
| `yarn link:dev` | Creates `happy-dev` global command |
| `yarn unlink:dev` | Removes `happy-dev` global command |
| `yarn link` | Standard yarn link for `happy` (if needed) |

### Understanding happy vs happy-dev

| Command | Data Directory | Use Case |
|---------|----------------|----------|
| `happy` | `~/.happy/` | Production mode (from npm) |
| `happy-dev` | `~/.happy-dev/` | Development mode (local build) |

Both run the same code. The difference is environment variables at launch (`HAPPY_VARIANT=dev` and `HAPPY_HOME_DIR=~/.happy-dev`).

### npm run Scripts (No Global Install)

Run variants directly from the project without global symlinks:

```bash
yarn setup:dev              # Create data directories

yarn stable <command>       # Run production variant
yarn dev:variant <command>  # Run development variant

# Quick commands
yarn stable:daemon:start    # Start stable daemon
yarn dev:daemon:start       # Start dev daemon
yarn stable:daemon:status   # Check stable status
yarn dev:daemon:status      # Check dev status
```

### Visual Indicators

Both versions show their mode on startup:
- **Stable:** `✅ STABLE MODE - Data: ~/.happy`
- **Dev:** `🔧 DEV MODE - Data: ~/.happy-dev`

### Data Isolation

| Aspect | Stable | Development |
|--------|--------|-------------|
| Data Directory | `~/.happy/` | `~/.happy-dev/` |
| Settings | `~/.happy/settings.json` | `~/.happy-dev/settings.json` |
| Daemon State | `~/.happy/daemon.state.json` | `~/.happy-dev/daemon.state.json` |
| Logs | `~/.happy/logs/` | `~/.happy-dev/logs/` |

### Advanced: direnv Auto-Switching

If you use [direnv](https://direnv.net/):

```bash
cp .envrc.example .envrc
direnv allow
```

Now `cd`-ing into the project directory automatically sets dev mode.

### Publishing to npm

```bash
yarn release    # Runs build, tests, and publishes
```

The npm package includes only the `happy` command. The `happy-dev` command is for local development only.

### Troubleshooting

**Permission denied with link:dev:**
```bash
sudo yarn link:dev
```

**"already exists" error:**
```bash
yarn unlink:dev
yarn link:dev
```

**Remove development setup:**
```bash
yarn unlink:dev   # Remove happy-dev
yarn unlink       # Remove all links
```

## Requirements

- Node.js >= 20.0.0
  - Required by `eventsource-parser@3.0.5`, which is required by
  `@modelcontextprotocol/sdk`, which we used to implement permission forwarding
  to mobile app
- Claude CLI installed & logged in (`claude` command available in PATH)

## License

MIT
