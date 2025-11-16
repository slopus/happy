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

Interested in contributing? See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup instructions, including how to run stable and development versions concurrently.

## 🔧 Development: Running Stable & Dev Versions Concurrently

For developers working on Happy, you can run both stable and development versions simultaneously with complete data isolation.

### Quick Start (One Command)

```bash
npm run setup:dev
```

This creates:
- `~/.happy/` - Stable version data
- `~/.happy-dev/` - Development version data

### Usage

**Stable version (production-ready):**
```bash
npm run stable auth login
npm run stable:daemon:start
```

**Development version (testing changes):**
```bash
npm run dev:variant auth login
npm run dev:daemon:start
```

### All Available Commands

**Stable:**
```bash
npm run stable <command>           # Any happy command
npm run stable:daemon:start        # Start stable daemon
npm run stable:daemon:stop         # Stop stable daemon
npm run stable:daemon:status       # Check stable status
npm run stable:auth <subcommand>   # Auth commands
```

**Development:**
```bash
npm run dev:variant <command>      # Any happy command
npm run dev:daemon:start           # Start dev daemon
npm run dev:daemon:stop            # Stop dev daemon
npm run dev:daemon:status          # Check dev status
npm run dev:auth <subcommand>      # Auth commands
```

### Visual Indicators

Both versions show their status on startup:
- **Stable:** `✅ STABLE MODE - Data: ~/.happy`
- **Dev:** `🔧 DEV MODE - Data: ~/.happy-dev`

### How It Works

- Uses `HAPPY_HOME_DIR` environment variable (already built-in)
- Cross-platform via Node.js (works on Windows/macOS/Linux)
- No manual configuration needed
- All commands in `package.json` for discoverability

### Advanced: direnv Auto-Switching (Optional)

If you use [direnv](https://direnv.net/):

```bash
cp .envrc.example .envrc
direnv allow
```

Now when you `cd` into your development directory, the environment switches to dev mode automatically!

### Data Isolation

| Aspect | Stable | Development |
|--------|--------|-------------|
| Data Directory | `~/.happy/` | `~/.happy-dev/` |
| Settings | `~/.happy/settings.json` | `~/.happy-dev/settings.json` |
| Daemon State | `~/.happy/daemon.state.json` | `~/.happy-dev/daemon.state.json` |
| Logs | `~/.happy/logs/` | `~/.happy-dev/logs/` |

Complete separation - no conflicts!

## Requirements

- Node.js >= 20.0.0
  - Required by `eventsource-parser@3.0.5`, which is required by
  `@modelcontextprotocol/sdk`, which we used to implement permission forwarding
  to mobile app
- Claude CLI installed & logged in (`claude` command available in PATH)

## License

MIT
